import { Money } from '@thesis/contracts'
import { expect, it } from 'vitest'
import { consumeFifo } from './fifo.ts'

// Money сравнивается через toString(): у него приватное #value, и toEqual
// считает любые два Money одинаковыми — проверено, сравнение было бы пустым.

it('списывает старый лот первым и считает прибыль по нему', () => {
  const lots = [
    { id: 'l1', qty: Money.of('1'), price: Money.of('100'), openedAt: new Date('2026-01-01') },
    { id: 'l2', qty: Money.of('1'), price: Money.of('200'), openedAt: new Date('2026-02-01') },
  ]

  const res = consumeFifo(lots, Money.of('1'), Money.of('300'), Money.of('0'))

  expect(res.consumptions).toHaveLength(1)
  expect(res.consumptions[0]?.lotId).toBe('l1')
  expect(res.consumptions[0]?.qty.toString()).toBe('1')
  expect(res.consumptions[0]?.realizedPnl.toString()).toBe('200')
  expect(res.remainingLots).toHaveLength(1)
  expect(res.remainingLots[0]?.id).toBe('l2')
})

it('разносит частичную продажу по двум лотам и вычитает комиссию', () => {
  const lots = [
    { id: 'l1', qty: Money.of('1'), price: Money.of('100'), openedAt: new Date('2026-01-01') },
    { id: 'l2', qty: Money.of('2'), price: Money.of('150'), openedAt: new Date('2026-02-01') },
  ]

  const res = consumeFifo(lots, Money.of('2'), Money.of('200'), Money.of('10'))

  expect(res.consumptions.map((c) => c.lotId)).toEqual(['l1', 'l2'])
  expect(res.consumptions.map((c) => c.qty.toString())).toEqual(['1', '1'])
  expect(res.remainingLots[0]?.qty.toString()).toBe('1')

  // Проверяется сумма, а не слагаемые: разнос комиссии по консумациям —
  // пропорционально или целиком в первую — остаётся решением реализации.
  // (200-100)*1 + (200-150)*1 - 10 комиссии
  const total = res.consumptions.reduce((acc, c) => acc.plus(c.realizedPnl), Money.of('0'))
  expect(total.toString()).toBe('140')
})

it('отказывается продать больше, чем есть', () => {
  const lots = [{ id: 'l1', qty: Money.of('1'), price: Money.of('100'), openedAt: new Date() }]

  expect(() => consumeFifo(lots, Money.of('2'), Money.of('200'), Money.of('0'))).toThrow(
    'not enough quantity',
  )
})

// Обязательный тест из шага 4: у сделок из отчёта Сбера время берётся из даты,
// поэтому лоты одного дня имеют одинаковый openedAt. Без второго ключа
// сортировки P&L начинает плавать между прогонами на одних и тех же данных.
it('при одинаковом openedAt даёт один результат независимо от порядка во входе', () => {
  const cheaper = {
    id: 'l1',
    qty: Money.of('1'),
    price: Money.of('100'),
    openedAt: new Date('2026-01-01'),
  }
  const pricier = {
    id: 'l2',
    qty: Money.of('1'),
    price: Money.of('200'),
    openedAt: new Date('2026-01-01'),
  }

  const direct = consumeFifo([cheaper, pricier], Money.of('1'), Money.of('300'), Money.of('0'))
  const reversed = consumeFifo([pricier, cheaper], Money.of('1'), Money.of('300'), Money.of('0'))

  for (const res of [direct, reversed]) {
    expect(res.consumptions[0]?.lotId).toBe('l1')
    expect(res.consumptions[0]?.realizedPnl.toString()).toBe('200')
    expect(res.remainingLots[0]?.id).toBe('l2')
  }
})
