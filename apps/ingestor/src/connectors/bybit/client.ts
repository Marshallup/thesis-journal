import { signedHeaders } from './signature.ts'
import type { Credentials } from './signature.ts'

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

// Ограничителя и размыкателя здесь ещё нет: они появятся в задаче 23, на
// Redis, общие для MOEX и биржи. Запись в docs/unknowns.md — «Ограничитель и
// размыкатель котировок живут в памяти процесса».
export class BybitClient {
  constructor(private readonly credentials: Credentials) {}

  queryApiKey(): Promise<ApiKeyInfo> {
    return this.get<ApiKeyInfo>('/v5/user/query-api')
  }

  private async get<T>(path: string, query = ''): Promise<T> {
    const timestamp = String(Date.now())
    const response = await fetch(`${BASE}${path}${query ? `?${query}` : ''}`, {
      headers: signedHeaders({ ...this.credentials, timestamp, query }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!response.ok) throw new Error(`Bybit ${path} ответил ${response.status}`)

    const body = (await response.json()) as Envelope<T>
    if (body.retCode !== 0) throw new Error(`Bybit ${path}: ${body.retCode} ${body.retMsg}`)
    return body.result
  }
}
