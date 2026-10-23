import { createHmac } from 'node:crypto'
import { expect, it } from 'vitest'
import { RECV_WINDOW, sign, signedHeaders } from './signature.ts'

const credentials = { apiKey: 'bybitPublicPart7f3a', secret: 'bybit-secret' }
const timestamp = '1792700000000'

// Порядок склейки — это и есть протокол. Перепутанный даёт «неверную подпись»,
// которую легко принять за неверный ключ: тест фиксирует порядок, а не факт
// существования HMAC.
it('подписывается склейка timestamp + apiKey + recvWindow + query', () => {
  const query = 'category=spot&limit=50'
  const expected = createHmac('sha256', credentials.secret)
    .update(`${timestamp}${credentials.apiKey}${RECV_WINDOW}${query}`)
    .digest('hex')

  expect(sign({ ...credentials, timestamp, query })).toBe(expected)
})

it('любое изменение входа меняет подпись', () => {
  const base = sign({ ...credentials, timestamp, query: '' })

  expect(sign({ ...credentials, timestamp: '1792700000001', query: '' })).not.toBe(base)
  expect(sign({ ...credentials, timestamp, query: 'category=spot' })).not.toBe(base)
  expect(sign({ ...credentials, secret: 'другой', timestamp, query: '' })).not.toBe(base)
})

it('заголовки несут ключ, время, окно и подпись', () => {
  const headers = signedHeaders({ ...credentials, timestamp, query: '' })

  expect(headers['X-BAPI-API-KEY']).toBe(credentials.apiKey)
  expect(headers['X-BAPI-TIMESTAMP']).toBe(timestamp)
  expect(headers['X-BAPI-RECV-WINDOW']).toBe(RECV_WINDOW)
  expect(headers['X-BAPI-SIGN']).toBe(sign({ ...credentials, timestamp, query: '' }))
  // Секрета в заголовках нет: он только в подписи.
  expect(JSON.stringify(headers)).not.toContain(credentials.secret)
})
