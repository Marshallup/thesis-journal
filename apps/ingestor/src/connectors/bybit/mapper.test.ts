import { expect, it } from 'vitest'
import { firstPage, secondPage } from '../../../test/fixtures/bybit-executions.ts'
import { WINDOW_MS, feeInTradeCurrency, mapExecution, quoteOf, splitWindows } from './mapper.ts'

// Семь дней — ограничение биржи. Окна считаются от начала, а последнее
// заканчивается там, где просили, а не «через семь дней».
it('режет промежуток на окна не больше семи дней', () => {
  const windows = splitWindows(new Date('2026-01-01T00:00:00Z'), new Date('2026-02-01T00:00:00Z'))

  expect(windows.every((window) => +window.to - +window.from <= WINDOW_MS)).toBe(true)
  expect(windows[0]?.from.toISOString()).toBe('2026-01-01T00:00:00.000Z')
  expect(windows.at(-1)?.to.toISOString()).toBe('2026-02-01T00:00:00.000Z')
})

it('промежуток короче окна остаётся одним окном', () => {
  const windows = splitWindows(new Date('2026-01-01T00:00:00Z'), new Date('2026-01-03T00:00:00Z'))

  expect(windows).toHaveLength(1)
  expect(windows[0]?.to.toISOString()).toBe('2026-01-03T00:00:00.000Z')
})

// Валюта пары — не «последние четыре символа»: `ETHBTC` котируется в BTC, а
// `BTCUSDC` — в USDC, и угадывание по длине ошибается молча.
it('котируемая валюта берётся из пары, а не угадывается по длине', () => {
  expect(quoteOf('BTCUSDT')).toBe('USDT')
  expect(quoteOf('BTCUSDC')).toBe('USDC')
  expect(quoteOf('ETHBTC')).toBe('BTC')
  expect(() => quoteOf('BTCXXX')).toThrow(/котируемую валюту/)
})

// Комиссия отдельным полем, а не вычтенной из цены: вычтенная тихо сдвигает
// себестоимость лота — ошибка, которую потом не найти.
//
// И уже в валюте сделки: покупка платит комиссию купленной монетой, а сложить
// BTC с USDT нельзя. Пересчёт идёт по цене этой же сделки — не оценка, а
// арифметика на известных числах: 0.00001 BTC × 64000 = 0.64 USDT.
it('покупка: комиссия в купленной монете приведена к валюте сделки', () => {
  const operation = mapExecution(firstPage.result.list[0]!)

  expect(operation).toMatchObject({
    kind: 'trade',
    side: 'buy',
    ticker: 'BTCUSDT',
    instrumentClass: 'crypto',
    quantity: '0.01',
    price: '64000',
    fee: '0.64',
    currency: 'USDT',
    externalId: 'exec-1',
  })
})

it('продажа: комиссия уже в валюте сделки и не пересчитывается', () => {
  const operation = mapExecution(secondPage.result.list[0]!)

  expect(operation).toMatchObject({ side: 'sell', fee: '0.325', currency: 'USDT' })
})

// Комиссия в третьей монете точному пересчёту не поддаётся: лучше не записать
// сделку, чем записать неверную себестоимость.
it('комиссия в третьей монете отбивается громко', () => {
  expect(() =>
    feeInTradeCurrency({ ...firstPage.result.list[0]!, feeCurrency: 'MNT' }, 'USDT'),
  ).toThrow(/пересчитать нечем/)
})

// Время биржи — миллисекунды строкой. Через число проходит только оно: деньги
// остаются строками везде.
it('время исполнения переводится в ISO UTC', () => {
  const operation = mapExecution(firstPage.result.list[0]!)

  expect(operation.executedAt).toBe(new Date(1792000000000).toISOString())
})
