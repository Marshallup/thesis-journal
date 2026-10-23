import { expect, it } from 'vitest'
import { readOnlyKey, tradingKey, withdrawKey } from '../../../test/fixtures/bybit-api-key.ts'
import { verdict } from './api-key.ts'

it('ключ только на чтение проходит, и его права видны', () => {
  const result = verdict(readOnlyKey.result)

  expect(result.ok).toBe(true)
  expect(result.scopes).toEqual(['Exchange:ExchangeHistory'])
})

// Обещание README — ключи принимаются только на чтение. Проверяется кодом, а
// не честным словом.
it('ключ с правом торговать отклоняется, и в причине сказано что делать', () => {
  const result = verdict(tradingKey.result)

  expect(result.ok).toBe(false)
  expect(result.ok === false && result.reason).toContain('Read-only')
  // Права перечислены: человеку надо видеть, что именно оказалось лишним.
  expect(result.scopes).toContain('Spot:SpotTrade')
})

// Вывод средств проверяется отдельно от флага: если его семантика у биржи
// изменится, отказать лишний раз дешевле, чем принять ключ на вывод денег.
it('право на вывод средств отклоняется даже при readOnly', () => {
  const result = verdict(withdrawKey.result)

  expect(result.ok).toBe(false)
  expect(result.ok === false && result.reason).toContain('вывод')
})

// Новая группа прав, о которой мы не знаем, при readOnly = 1 читать может и
// только читать: отклонять её значило бы ломаться от каждого нововведения
// биржи.
it('незнакомая группа прав при readOnly не мешает', () => {
  const result = verdict({ readOnly: 1, permissions: { Earn: ['Earn'], Future: ['Peek'] } })

  expect(result.ok).toBe(true)
  expect(result.scopes).toEqual(['Earn:Earn', 'Future:Peek'])
})
