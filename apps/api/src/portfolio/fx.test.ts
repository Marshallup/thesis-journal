import { Money } from '@thesis/contracts'
import { expect, it } from 'vitest'
import { toSingleTotal } from './fx.ts'

const NOW = new Date('2026-10-24T12:00:00.000Z')
const rate = (value: string, quotedAt = '2026-10-24T00:00:00.000Z') => ({
  value,
  quotedAt: new Date(quotedAt),
})
const totals = (...pairs: [string, string][]): [string, Money][] =>
  pairs.map(([currency, amount]) => [currency, Money.of(amount)])

it('итог в рублях складывает рублёвый и долларовый счёт по курсу', () => {
  const total = toSingleTotal(totals(['RUB', '1000'], ['USDT', '50']), rate('80'), NOW)

  // 1000 ₽ + 50 USDT × 80 = 5000 ₽.
  expect(total).toMatchObject({ currency: 'RUB', totalPnl: '5000', incomplete: false })
  expect(total.rate).toMatchObject({ pair: 'USDRUB', value: '80', stale: false })
})

// Главный тест задачи: итог по выдуманному курсу выглядит ровно как настоящий,
// и проверить его на экране нечем. Поэтому курса нет — итога нет.
it('без курса итог не выдумывается', () => {
  const total = toSingleTotal(totals(['RUB', '1000'], ['USDT', '50']), null, NOW)

  expect(total.rate).toBeNull()
  expect(total).toMatchObject({ incomplete: true, unconverted: ['USDT'] })
  // Рублёвая часть осталась суммой, доллары не приплюсованы как рубли.
  expect(total.totalPnl).toBe('1000')
})

it('курс старше трёх суток помечен устаревшим, а не применён молча', () => {
  const stale = toSingleTotal(totals(['USDT', '10']), rate('80', '2026-10-19T00:00:00.000Z'), NOW)

  expect(stale.rate).toMatchObject({ stale: true })
  // Применён всё равно: других курсов нет, и молчать о сумме хуже, чем о дате.
  expect(stale.totalPnl).toBe('800')
})

// Выходные: ЦБ не публикует курс, и пятничный курс в субботу — норма, а не
// поломка. Метка «устарел» должна значить «забор сломан», иначе её не читают.
it('курс пятницы в выходные устаревшим не считается', () => {
  const weekend = toSingleTotal(
    totals(['USDT', '10']),
    rate('80', '2026-10-23T00:00:00.000Z'),
    new Date('2026-10-25T12:00:00.000Z'),
  )

  expect(weekend.rate).toMatchObject({ stale: false })
})

// Юань есть в выгрузке ЦБ, но пары у нас нет: такую валюту нельзя ни выбросить
// молча, ни посчитать долларом.
it('валюта без курса делает итог неполным', () => {
  const total = toSingleTotal(totals(['RUB', '100'], ['CNY', '50']), rate('80'), NOW)

  expect(total).toMatchObject({ totalPnl: '100', incomplete: true, unconverted: ['CNY'] })
})
