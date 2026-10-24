import { Money } from '@thesis/contracts'

// Комиссия приводится к валюте сделки по цене этой же сделки. Это не оценка и
// не курс: спот берёт комиссию монетой той же пары в тот же момент, и цена
// известна из самого исполнения. Решено 23.10.2026.
//
// Третья монета (комиссия со скидкой за токен площадки) точному пересчёту не
// поддаётся, и тогда отказ громкий: лучше не записать сделку, чем записать
// неверную себестоимость. Запись в docs/unknowns.md.
//
// Правило одно для API и для выгрузки из кабинета: в обоих случаях биржа берёт
// комиссию купленной монетой, и разойтись эти два пути не должны.
export function feeInQuote(params: {
  fee: string
  feeCurrency: string
  symbol: string
  price: string
  quote: string
  what: string
}): string {
  const { fee, feeCurrency, symbol, price, quote, what } = params
  if (!feeCurrency || feeCurrency === quote) return fee

  const base = symbol.slice(0, -quote.length)
  if (feeCurrency === base) return Money.of(fee).times(price).toString()

  throw new Error(
    `комиссия ${what} взята в ${feeCurrency}: это ни ${base}, ни ${quote} — пересчитать нечем`,
  )
}
