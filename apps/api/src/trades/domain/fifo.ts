import { Money } from '@thesis/contracts'

// Лот несёт остаток затрат целиком, а не цену за единицу: комиссия покупки
// входит в затраты, и хранить её «в цене» значило бы делить при каждой покупке.
export type Lot = { id: string; qty: Money; cost: Money; openedAt: Date }
export type Consumption = { lotId: string; qty: Money; cost: Money; realizedPnl: Money }
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

  const slices: { lot: Lot; qty: Money; cost: Money }[] = []
  const remainingLots: Lot[] = []
  let left = sellQty

  for (const lot of ordered) {
    if (left.eq(ZERO)) {
      remainingLots.push(lot)
      continue
    }

    const qty = left.lt(lot.qty) ? left : lot.qty
    // Закрывающая порция забирает ровно остаток затрат — без деления и без
    // потерянных копеек. Частичная берёт пропорциональную долю.
    const cost = qty.eq(lot.qty) ? lot.cost : lot.cost.times(qty).div(lot.qty)
    slices.push({ lot, qty, cost })

    const restQty = lot.qty.minus(qty)
    if (!restQty.eq(ZERO)) {
      remainingLots.push({ ...lot, qty: restQty, cost: lot.cost.minus(cost) })
    }
    left = left.minus(qty)
  }

  // Комиссия продажи — пропорционально количеству, последняя консумация
  // забирает остаток. Поэтому сумма долей точно равна комиссии при любой нарезке.
  let allocated = ZERO
  const consumptions = slices.map(({ lot, qty, cost }, i) => {
    const share = i === slices.length - 1 ? fee.minus(allocated) : fee.times(qty).div(sellQty)
    allocated = allocated.plus(share)
    return {
      lotId: lot.id,
      qty,
      cost,
      realizedPnl: sellPrice.times(qty).minus(cost).minus(share),
    }
  })

  return { consumptions, remainingLots }
}
