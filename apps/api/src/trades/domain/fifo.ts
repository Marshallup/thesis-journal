import { Money } from '@thesis/contracts'

export type Lot = { id: string; qty: Money; price: Money; openedAt: Date }
export type Consumption = { lotId: string; qty: Money; realizedPnl: Money }
export type SellResult = { consumptions: Consumption[]; remainingLots: Lot[] }

const ZERO = Money.of('0')

// Второй ключ обязателен: время сделки из отчёта берётся из даты, поэтому лоты
// одного дня имеют одинаковый openedAt. id — uuidv7, упорядочен по вставке.
function byFifo(a: Lot, b: Lot): number {
  const byOpenedAt = a.openedAt.getTime() - b.openedAt.getTime()
  if (byOpenedAt !== 0) return byOpenedAt
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

export function consumeFifo(lots: Lot[], sellQty: Money, sellPrice: Money, fee: Money): SellResult {
  // toSorted, а не sort: входной массив принадлежит вызывающему.
  const ordered = lots.toSorted(byFifo)

  const available = ordered.reduce((acc, lot) => acc.plus(lot.qty), ZERO)
  if (available.lt(sellQty)) throw new Error('not enough quantity')

  const consumptions: Consumption[] = []
  const remainingLots: Lot[] = []
  let left = sellQty

  for (const lot of ordered) {
    if (left.eq(ZERO)) {
      remainingLots.push(lot)
      continue
    }

    const taken = left.lt(lot.qty) ? left : lot.qty
    const gross = sellPrice.minus(lot.price).times(taken)
    // Комиссия целиком в первую консумацию, а не пропорционально по лотам.
    const realizedPnl = consumptions.length === 0 ? gross.minus(fee) : gross
    consumptions.push({ lotId: lot.id, qty: taken, realizedPnl })

    const rest = lot.qty.minus(taken)
    if (!rest.eq(ZERO)) remainingLots.push({ ...lot, qty: rest })
    left = left.minus(taken)
  }

  return { consumptions, remainingLots }
}
