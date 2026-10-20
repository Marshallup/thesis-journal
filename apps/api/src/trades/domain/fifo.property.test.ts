import { Money } from '@thesis/contracts'
import fc from 'fast-check'
import { expect, it } from 'vitest'
import { consumeFifo } from './fifo.ts'

// Инвариант, который примерами не придумаешь: количество сохраняется при любой
// раскладке лотов. Ловит потерю остатка на частичном списании.
it('сколько списали из лотов, столько и продали — при любой последовательности', () => {
  fc.assert(
    fc.property(
      fc.array(fc.integer({ min: 1, max: 1000 }), { minLength: 1, maxLength: 20 }),
      fc.integer({ min: 1, max: 500 }),
      (lotSizes, sellUnits) => {
        const lots = lotSizes.map((q, i) => ({
          id: `l${i}`,
          qty: Money.of(String(q)),
          price: Money.of('100'),
          openedAt: new Date(2026, 0, i + 1),
        }))
        const totalQty = lotSizes.reduce((a, b) => a + b, 0)
        fc.pre(sellUnits <= totalQty)

        const res = consumeFifo(lots, Money.of(String(sellUnits)), Money.of('150'), Money.of('0'))

        const consumed = res.consumptions.reduce((acc, c) => acc.plus(c.qty), Money.of('0'))
        const left = res.remainingLots.reduce((acc, l) => acc.plus(l.qty), Money.of('0'))

        expect(consumed.toString()).toBe(String(sellUnits))
        expect(left.plus(consumed).toString()).toBe(String(totalQty))
      },
    ),
  )
})
