import { Money } from '@thesis/contracts'
import { expect, it } from 'vitest'
import { consumeFifo } from './fifo.ts'

// Money сравнивается через toString(): у него приватное #value, и toEqual
// считает любые два Money одинаковыми — проверено, сравнение было бы пустым.

it('списывает старый лот первым и считает прибыль по нему', () => {
  const lots = [
    { id: 'l1', qty: Money.of('1'), cost: Money.of('100'), openedAt: new Date('2026-01-01') },
    { id: 'l2', qty: Money.of('1'), cost: Money.of('200'), openedAt: new Date('2026-02-01') },
  ]

  const res = consumeFifo(lots, Money.of('1'), Money.of('300'), Money.of('0'))

  expect(res.consumptions).toHaveLength(1)
  expect(res.consumptions[0]?.lotId).toBe('l1')
  expect(res.consumptions[0]?.qty.toString()).toBe('1')
  expect(res.consumptions[0]?.cost.toString()).toBe('100')
  expect(res.consumptions[0]?.realizedPnl.toString()).toBe('200')
  expect(res.remainingLots).toHaveLength(1)
  expect(res.remainingLots[0]?.id).toBe('l2')
})

it('разносит частичную продажу по двум лотам и делит комиссию пропорционально', () => {
  const lots = [
    { id: 'l1', qty: Money.of('1'), cost: Money.of('100'), openedAt: new Date('2026-01-01') },
    { id: 'l2', qty: Money.of('2'), cost: Money.of('300'), openedAt: new Date('2026-02-01') },
  ]

  const res = consumeFifo(lots, Money.of('2'), Money.of('200'), Money.of('10'))

  expect(res.consumptions.map((c) => c.lotId)).toEqual(['l1', 'l2'])
  expect(res.consumptions.map((c) => c.qty.toString())).toEqual(['1', '1'])
  // l1 закрывается — забирает весь свой остаток затрат; l2 отдаёт половину.
  expect(res.consumptions.map((c) => c.cost.toString())).toEqual(['100', '150'])
  // комиссия 10 на две равные порции — по 5 в каждую
  expect(res.consumptions.map((c) => c.realizedPnl.toString())).toEqual(['95', '45'])
  expect(res.remainingLots[0]?.qty.toString()).toBe('1')
  expect(res.remainingLots[0]?.cost.toString()).toBe('150')
})

it('отказывается продать больше, чем есть', () => {
  const lots = [{ id: 'l1', qty: Money.of('1'), cost: Money.of('100'), openedAt: new Date() }]

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
    cost: Money.of('100'),
    openedAt: new Date('2026-01-01'),
  }
  const pricier = {
    id: 'l2',
    qty: Money.of('1'),
    cost: Money.of('200'),
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

// Затраты 310 на три штуки не делятся нацело. Продаём по одной: первые две
// получают округлённую долю, последняя забирает остаток — и сумма сходится
// точно. Именно это и есть причина не делить комиссию «на глазок».
it('распродажа лота по частям относит затраты без потери копеек', () => {
  let lots = [
    { id: 'l1', qty: Money.of('3'), cost: Money.of('310'), openedAt: new Date('2026-01-01') },
  ]
  const costs: string[] = []
  const pnls: string[] = []

  for (let i = 0; i < 3; i++) {
    const res = consumeFifo(lots, Money.of('1'), Money.of('150'), Money.of('0'))
    costs.push(res.consumptions[0]?.cost.toString() ?? '')
    pnls.push(res.consumptions[0]?.realizedPnl.toString() ?? '')
    lots = res.remainingLots
  }

  expect(lots).toHaveLength(0)
  const totalCost = costs.reduce((acc, c) => acc.plus(c), Money.of('0'))
  const totalPnl = pnls.reduce((acc, p) => acc.plus(p), Money.of('0'))
  expect(totalCost.toString()).toBe('310')
  expect(totalPnl.toString()).toBe('140') // 3 * 150 - 310
})
