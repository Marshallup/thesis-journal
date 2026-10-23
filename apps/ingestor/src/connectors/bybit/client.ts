import { signedHeaders } from './signature.ts'
import type { Credentials } from './signature.ts'
import type { ExternalCall } from '../../outbound/external-call.ts'

const BASE = 'https://api.bybit.com'

// Биржа может не ответить вовсе. Без таймаута команда висит до конца жизни
// процесса и держит очередь: prefetch у консьюмера — одно сообщение.
const TIMEOUT_MS = 10_000

// Ответ Bybit всегда в конверте: HTTP 200 бывает и на отказе, настоящий код —
// retCode.
type Envelope<T> = { retCode: number; retMsg: string; result: T }

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
    if (body.retCode !== 0) throw new Error(`Bybit ${path}: ${body.retCode} ${body.retMsg}`)
    return body.result
  }
}
