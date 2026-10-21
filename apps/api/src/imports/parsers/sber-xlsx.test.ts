import { expect, it } from 'vitest'
import { buildSberOperationsXlsx } from '../../../test/fixtures/sber-operations.ts'
import { parseSberXlsx } from './sber-xlsx.ts'

const file = await buildSberOperationsXlsx()

it('разбирает покупку акции', async () => {
  const ops = await parseSberXlsx(file)
  const buy = ops.find((o) => o.externalId === '77001')

  expect(buy).toMatchObject({
    kind: 'trade',
    side: 'buy',
    ticker: 'SBER',
    instrumentClass: 'equity',
    quantity: '10',
    price: '250.5',
    currency: 'RUB',
  })
  // Деньги и количества остаются строками на всём пути от файла до базы.
  expect(typeof buy?.quantity).toBe('string')
  expect(typeof buy?.price).toBe('string')
})

it('не считает дивиденд сделкой', async () => {
  const ops = await parseSberXlsx(file)
  const dividend = ops.find((o) => o.cashKind === 'dividend')

  expect(dividend).toMatchObject({ kind: 'cash', ticker: 'SBER', amount: '340.2' })
  expect(ops.filter((o) => o.kind === 'trade').every((o) => o.ticker)).toBe(true)
})

it('даёт одинаковый externalId при повторном разборе того же файла', async () => {
  const first = await parseSberXlsx(file)
  const second = await parseSberXlsx(file)

  expect(first.map((o) => o.externalId)).toEqual(second.map((o) => o.externalId))
})

// Номер сделки есть в выгрузке у каждой сделки — хеш для них не нужен.
it('берёт externalId сделки из номера сделки', async () => {
  const ops = await parseSberXlsx(file)
  const trades = ops.filter((o) => o.kind === 'trade')

  expect(trades.map((o) => o.externalId)).toEqual(['77004', '77003', '77002', '77001'])
})

// Два одинаковых пополнения с совпадающей секундой обязаны получить разные
// externalId, иначе второе отсеется как дубль и деньги пропадут.
it('различает одинаковые денежные операции одной секунды', async () => {
  const ops = await parseSberXlsx(file)
  const deposits = ops.filter((o) => o.cashKind === 'deposit' && o.amount === '1000')

  expect(deposits).toHaveLength(2)
  expect(new Set(deposits.map((o) => o.externalId)).size).toBe(2)
})

// Комиссии приходят отдельными строками и к сделке не привязываются: в выгрузке
// такой связи нет. Разбор — в docs/unknowns.md.
it('относит комиссию к денежным операциям, а не к сделке', async () => {
  const ops = await parseSberXlsx(file)

  // В файле сумма положительная у всех операций, направление даёт «Операция»:
  // списание обязано прийти со минусом, иначе сумма ledger не сойдётся с балансом.
  expect(ops.find((o) => o.cashKind === 'fee')).toMatchObject({
    kind: 'cash',
    amount: '-11.28',
    currency: 'RUB',
  })
  expect(ops.filter((o) => o.kind === 'trade').every((o) => o.fee === '0')).toBe(true)
})

// Облигацию из «Сделок» не разобрать: накопленного купона в листе нет, а цена
// в процентах от номинала. Единственный признак — «Объем сделки», который не
// сходится с количеством и ценой. Импорт обязан встать, а не занести
// себестоимость в десять раз меньше настоящей.
it('не принимает сделку, где объём не сходится с количеством и ценой', async () => {
  const withBond = await buildSberOperationsXlsx({ bond: true })

  await expect(parseSberXlsx(withBond)).rejects.toThrow(/77005/)
})

// Секунды в выгрузке целые. Дробные миллисекунды здесь не «некрасиво», а
// признак того, что по дороге потерялась точность: время сделки — вход в хеш
// денежной операции и в сортировку лотов.
it('отдаёт время целыми секундами', async () => {
  const ops = await parseSberXlsx(file)

  expect(ops.filter((o) => !o.executedAt.endsWith('.000Z'))).toEqual([])
})

// Время в выгрузке есть, стенные часы московские: сдвинуть их на зону
// обязательно, иначе сделка вечерней сессии уедет на другой день.
it('переводит московское время сделки в UTC', async () => {
  const ops = await parseSberXlsx(file)

  expect(ops.find((o) => o.externalId === '77001')?.executedAt).toBe('2026-08-03T07:15:04.000Z')
})
