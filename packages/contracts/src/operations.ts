// Операция из отчёта брокера. С разделением сервисов этот тип перестал быть
// внутренним делом парсера и стал контрактом: его отдаёт ingestor и принимает
// api, а значит менять его молча нельзя.
//
// Деньги и количества — строки. В JSON они тем более строки: число в JSON это
// double, и 0.1 + 0.2 случится уже на той стороне.

export type CashKind = 'dividend' | 'coupon' | 'tax' | 'deposit' | 'fee'

// Инструмент уникален по паре (symbol, class) — без класса не найти его id.
export type InstrumentClass = 'equity' | 'bond' | 'etf' | 'crypto' | 'currency'

export type RawOperation = {
  kind: 'trade' | 'cash'
  side?: 'buy' | 'sell'
  ticker?: string
  instrumentClass?: InstrumentClass
  quantity?: string
  price?: string
  fee?: string
  currency: string
  amount?: string
  cashKind?: CashKind
  // ISO UTC. Московское время переведено ещё парсером: смещение считается
  // через Intl, а не прибавлением часов.
  executedAt: string
  // Номер операции из отчёта — он же ключ идемпотентности при применении.
  externalId: string
}
