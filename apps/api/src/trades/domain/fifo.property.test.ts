import { Money } from '@thesis/contracts'
import fc from 'fast-check'
import { expect, it } from 'vitest'
import { consumeFifo } from './fifo.ts'

const lotSizes = fc.array(fc.integer({ min: 1, max: 1000 }), { minLength: 1, maxLength: 20 })
const sellUnits = fc.integer({ min: 1, max: 500 })

// Затраты лота намеренно не делятся на его количество нацело: +10 на лот
// заставляет каждое частичное списание округлять долю.
function makeLots(sizes: number[]) {
  return sizes.map((q, i) => ({
    id: `l${i}`,
    qty: Money.of(String(q)),
    cost: Money.of(String(q * 100 + 10)),
    openedAt: new Date(2026, 0, i + 1),
  }))
}

const sum = (values: Money[]) => values.reduce((acc, v) => acc.plus(v), Money.of('0'))

// Инвариант, который примерами не придумаешь: количество сохраняется при любой
// раскладке лотов. Ловит потерю остатка на частичном списании.
it('сколько списали из лотов, столько и продали — при любой последовательности', () => {
  fc.assert(
    fc.property(lotSizes, sellUnits, (sizes, units) => {
      const lots = makeLots(sizes)
      const totalQty = sizes.reduce((a, b) => a + b, 0)
      fc.pre(units <= totalQty)

      const res = consumeFifo(lots, Money.of(String(units)), Money.of('150'), Money.of('0'))

      const consumed = sum(res.consumptions.map((c) => c.qty))
      const left = sum(res.remainingLots.map((l) => l.qty))

      expect(consumed.toString()).toBe(String(units))
      expect(left.plus(consumed).toString()).toBe(String(totalQty))
    }),
  )
})

// Главный инвариант пропорционального разноса: округление доли не создаёт и не
// теряет копеек, потому что остаток лота считается вычитанием, а не вторым
// делением. Комиссия сходится по той же причине — последняя доля остаточная.
it('затраты и комиссия сходятся точно при любой нарезке', () => {
  fc.assert(
    fc.property(lotSizes, sellUnits, (sizes, units) => {
      const lots = makeLots(sizes)
      fc.pre(units <= sizes.reduce((a, b) => a + b, 0))
      const totalCost = sum(lots.map((l) => l.cost))
      const price = Money.of('150')
      const fee = Money.of('7')

      const res = consumeFifo(lots, Money.of(String(units)), price, fee)

      const attributed = sum(res.consumptions.map((c) => c.cost))
      const leftCost = sum(res.remainingLots.map((l) => l.cost))
      const pnl = sum(res.consumptions.map((c) => c.realizedPnl))

      expect(attributed.plus(leftCost).toString()).toBe(totalCost.toString())
      expect(pnl.toString()).toBe(
        price.times(String(units)).minus(attributed).minus(fee).toString(),
      )
    }),
  )
})
