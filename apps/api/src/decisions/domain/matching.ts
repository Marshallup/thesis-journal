export type MatchInput = {
  decision: {
    id: string
    accountId: string
    instrumentId: string
    side: 'buy' | 'sell'
    createdAt: Date
    horizonDays: number
  }
  trades: Array<{
    id: string
    accountId: string
    instrumentId: string
    side: 'buy' | 'sell'
    executedAt: Date
    linkedDecisionId: string | null
  }>
}

export type MatchResult =
  | { kind: 'auto'; tradeId: string }
  | { kind: 'ambiguous'; tradeIds: string[] }
  | { kind: 'none' }

const DAY_MS = 24 * 60 * 60 * 1000

export function matchDecisionToTrades({ decision, trades }: MatchInput): MatchResult {
  const from = decision.createdAt.getTime()
  // Граница включительна: сделка последнего дня горизонта ещё относится к решению.
  const until = from + decision.horizonDays * DAY_MS

  const candidates = trades
    .filter((trade) => {
      if (trade.linkedDecisionId !== null) return false
      if (trade.accountId !== decision.accountId) return false
      if (trade.instrumentId !== decision.instrumentId) return false
      if (trade.side !== decision.side) return false
      const executed = trade.executedAt.getTime()
      // Сделка раньше решения — это не исполнение тезиса, а рационализация
      // задним числом. См. docs/design.md §2.1.
      return executed >= from && executed <= until
    })
    // Второй ключ по id: у сделок из отчёта время берётся из даты, и без него
    // список на подтверждение прыгал бы между запросами.
    .toSorted((a, b) => a.executedAt.getTime() - b.executedAt.getTime() || (a.id < b.id ? -1 : 1))

  if (candidates.length === 0) return { kind: 'none' }
  // Один кандидат — привязываем; больше одного — не угадываем, спрашиваем.
  if (candidates.length === 1) return { kind: 'auto', tradeId: candidates[0]!.id }
  return { kind: 'ambiguous', tradeIds: candidates.map((trade) => trade.id) }
}
