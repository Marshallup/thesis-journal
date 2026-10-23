import { createHmac } from 'node:crypto'

// Окно, в котором биржа принимает подпись. Пять секунд — рекомендация Bybit:
// шире окно — шире форточка для повторной отправки перехваченного запроса.
export const RECV_WINDOW = '5000'

export type Credentials = { apiKey: string; secret: string }

type Signable = Credentials & { timestamp: string; query: string; recvWindow?: string }

// Подпись v5 — HMAC-SHA256 от склейки timestamp + apiKey + recvWindow + query,
// именно в этом порядке. Порядок — часть протокола, и перепутанный даёт
// «неверную подпись», которую легко принять за неверный ключ и полдня искать
// не там.
export function sign(params: Signable): string {
  const { secret, apiKey, timestamp, query, recvWindow = RECV_WINDOW } = params
  return createHmac('sha256', secret)
    .update(`${timestamp}${apiKey}${recvWindow}${query}`)
    .digest('hex')
}

export function signedHeaders(params: Signable): Record<string, string> {
  return {
    'X-BAPI-API-KEY': params.apiKey,
    'X-BAPI-TIMESTAMP': params.timestamp,
    'X-BAPI-RECV-WINDOW': params.recvWindow ?? RECV_WINDOW,
    'X-BAPI-SIGN': sign(params),
  }
}
