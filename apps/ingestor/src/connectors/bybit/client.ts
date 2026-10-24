import { signedHeaders } from './signature.ts'
import type { Credentials } from './signature.ts'
import type { Execution } from './mapper.ts'
import type { ExternalCall } from '../../outbound/external-call.ts'

const BASE = 'https://api.bybit.com'

// Биржа может не ответить вовсе. Без таймаута команда висит до конца жизни
// процесса и держит очередь: prefetch у консьюмера — одно сообщение.
const TIMEOUT_MS = 10_000

// Ответ Bybit всегда в конверте: HTTP 200 бывает и на отказе, настоящий код —
// retCode.
type Envelope<T> = { retCode: number; retMsg: string; result: T }

// Код ответа нужен вызывающему, а не только в тексте ошибки: по нему видно,
// чья это ошибка. Правило проекта требует различать их — ошибка провайдера
// ретраится, своя нет.
export class BybitError extends Error {
  constructor(
    readonly retCode: number,
    message: string,
  ) {
    super(message)
    this.name = 'BybitError'
  }
}

// Параметры, ключ, подпись, права, адрес — всё это наши ошибки: повтор их не
// лечит, а три попытки впустую только тратят лимит и время. Остальное (лимиты,
// пятисотки, сеть) ретраится, как и раньше.
const PERMANENT = new Set([
  10001, // ошибка в параметрах запроса
  10003, // ключ недействителен
  10004, // подпись не сошлась
  10005, // у ключа нет прав на этот запрос
  10010, // запрос с адреса, не входящего в белый список ключа
  33004, // срок действия ключа истёк
])

export function isPermanent(error: unknown): boolean {
  return error instanceof BybitError && PERMANENT.has(error.retCode)
}

export type ExecutionPage = {
  list: Execution[]
  nextPageCursor: string
}

export type ApiKeyInfo = {
  // 0 — чтение и запись, 1 — только чтение. Так это описано у биржи.
  readOnly: number
  permissions: Record<string, string[]>
}

// Каждый запрос идёт через общий ограничитель и размыкатель: правило проекта,
// и у биржи оно тем важнее, чем MOEX — лимиты у Bybit считаются на ключ и на
// адрес, а отказ по лимиту выглядит как отказ по правам.
export class BybitClient {
  constructor(
    private readonly credentials: Credentials,
    private readonly calls: ExternalCall,
  ) {}

  queryApiKey(): Promise<ApiKeyInfo> {
    return this.get<ApiKeyInfo>('/v5/user/query-api')
  }

  // Сто строк — максимум, который отдаёт биржа за один запрос. Дальше курсор.
  executions(params: {
    category: 'spot'
    from: Date
    to: Date
    cursor?: string
  }): Promise<ExecutionPage> {
    const query = new URLSearchParams({
      category: params.category,
      startTime: String(params.from.getTime()),
      endTime: String(params.to.getTime()),
      limit: '100',
      ...(params.cursor ? { cursor: params.cursor } : {}),
    })
    return this.get<ExecutionPage>('/v5/execution/list', query.toString())
  }

  private async get<T>(path: string, query = ''): Promise<T> {
    const response = await this.calls.run('bybit', () => {
      // Время берётся перед самой отправкой: подпись живёт recvWindow
      // миллисекунд, и ожидание в очереди ограничителя может её просрочить.
      const timestamp = String(Date.now())
      return fetch(`${BASE}${path}${query ? `?${query}` : ''}`, {
        headers: signedHeaders({ ...this.credentials, timestamp, query }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
    })
    if (!response.ok) throw new Error(`Bybit ${path} ответил ${response.status}`)

    const body = (await response.json()) as Envelope<T>
    if (body.retCode !== 0) {
      throw new BybitError(body.retCode, `Bybit ${path}: ${body.retCode} ${body.retMsg}`)
    }
    return body.result
  }
}
