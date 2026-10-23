import { Money } from '@thesis/contracts'
import type { RawOperation } from '@thesis/contracts'

// Окно истории у Bybit — не больше семи дней: ограничение биржи, не наше.
export const WINDOW_MS = 7 * 24 * 60 * 60 * 1000

// Котируемые валюты, какие бывают на споте. Список, а не «последние четыре
// символа»: пары бывают и `ETHBTC`, и `BTCUSDC`, и угадывание по длине
// ошибается молча. Длинные идут первыми — `USDC` должен проверяться раньше
// `USD`.
const QUOTES = ['USDT', 'USDC', 'USDE', 'EUR', 'TRY', 'BRZ', 'BTC', 'ETH', 'DAI']

// Строки биржи приходят как есть: цена и количество остаются строками, через
// число не проходят. 0.1 + 0.2 случилось бы ровно здесь.
export type Execution = {
  execId: string
  symbol: string
  side: 'Buy' | 'Sell'
  execPrice: string
  execQty: string
  execFee: string
  feeCurrency: string
  execTime: string
  execType: string
}

// Промежуток режется на окна по семь дней. Последнее окно короче остальных —
// его правая граница равна запрошенной, а не «семь дней от начала».
export function splitWindows(from: Date, to: Date): { from: Date; to: Date }[] {
  const windows: { from: Date; to: Date }[] = []
  for (let start = from.getTime(); start < to.getTime(); start += WINDOW_MS) {
    windows.push({ from: new Date(start), to: new Date(Math.min(start + WINDOW_MS, to.getTime())) })
  }
  return windows
}

// Валюта сделки — котируемая часть пары: у `BTCUSDT` это `USDT`. Неизвестная
// пара — это не повод записать выдуманную валюту: лучше отказ.
export function quoteOf(symbol: string): string {
  const quote = QUOTES.find((candidate) => symbol.endsWith(candidate) && symbol !== candidate)
  if (!quote) throw new Error(`не знаю котируемую валюту пары ${symbol}`)
  return quote
}

// Комиссия приводится к валюте сделки по цене этой же сделки. Это не оценка и
// не курс: спот берёт комиссию монетой той же пары в тот же момент, и цена
// известна из самого исполнения. Решено 23.10.2026.
//
// Третья монета (комиссия со скидкой за токен площадки) точному пересчёту не
// поддаётся, и тогда отказ громкий: лучше не записать сделку, чем записать
// неверную себестоимость. Запись в docs/unknowns.md.
export function feeInTradeCurrency(row: Execution, currency: string): string {
  if (!row.feeCurrency || row.feeCurrency === currency) return row.execFee

  const base = row.symbol.slice(0, -currency.length)
  if (row.feeCurrency === base) {
    return Money.of(row.execFee).times(row.execPrice).toString()
  }

  throw new Error(
    `комиссия исполнения ${row.execId} взята в ${row.feeCurrency}: ` +
      `это ни ${base}, ни ${currency} — пересчитать нечем`,
  )
}

export function mapExecution(row: Execution): RawOperation {
  const currency = quoteOf(row.symbol)
  return {
    kind: 'trade',
    side: row.side === 'Buy' ? 'buy' : 'sell',
    ticker: row.symbol,
    instrumentClass: 'crypto',
    quantity: row.execQty,
    price: row.execPrice,
    // Комиссия отдельным полем, а не вычтенная из цены: вычтенная тихо
    // сдвигает себестоимость лота. И уже в валюте сделки — спотовая покупка
    // платит её купленной монетой, и складывать BTC с USDT нельзя.
    fee: feeInTradeCurrency(row, currency),
    currency,
    executedAt: new Date(Number(row.execTime)).toISOString(),
    // `execId` — идентификатор исполнения, он же ключ идемпотентности. Не
    // `orderId`: одна заявка исполняется частями, и у каждой части своя цена.
    externalId: row.execId,
  }
}
