import { expect, it } from 'vitest'
import { matchDecisionToTrades } from './matching.ts'

const base = {
  id: 'd1',
  accountId: 'a1',
  instrumentId: 'i1',
  side: 'buy' as const,
  createdAt: new Date('2026-03-01T10:00:00Z'),
  horizonDays: 7,
}

const trade = (
  id: string,
  overrides: Partial<Parameters<typeof matchDecisionToTrades>[0]['trades'][number]> = {},
) => ({
  id,
  accountId: 'a1',
  instrumentId: 'i1',
  side: 'buy' as const,
  executedAt: new Date('2026-03-01T12:00:00Z'),
  linkedDecisionId: null,
  ...overrides,
})

it('привязывает автоматически, когда кандидат ровно один', () => {
  const res = matchDecisionToTrades({ decision: base, trades: [trade('t1')] })

  expect(res).toEqual({ kind: 'auto', tradeId: 't1' })
})

it('не гадает, когда кандидатов двое — отдаёт на подтверждение', () => {
  const res = matchDecisionToTrades({
    decision: base,
    trades: [trade('t1'), trade('t2', { executedAt: new Date('2026-03-02T12:00:00Z') })],
  })

  expect(res).toEqual({ kind: 'ambiguous', tradeIds: ['t1', 't2'] })
})

it('игнорирует сделку за пределами горизонта и уже привязанную', () => {
  const res = matchDecisionToTrades({
    decision: base,
    trades: [
      trade('late', { executedAt: new Date('2026-04-01T12:00:00Z') }),
      trade('taken', { linkedDecisionId: 'd0' }),
    ],
  })

  expect(res).toEqual({ kind: 'none' })
})

// Принципиальный тест: решение записывается ДО сделки, иначе это рационализация
// задним числом (docs/design.md §2.1).
it('не привязывает сделку, совершённую до записи решения', () => {
  const res = matchDecisionToTrades({
    decision: base,
    trades: [trade('early', { executedAt: new Date('2026-02-28T12:00:00Z') })],
  })

  expect(res).toEqual({ kind: 'none' })
})

it('не путает счёт, инструмент и направление', () => {
  const res = matchDecisionToTrades({
    decision: base,
    trades: [
      trade('other-account', { accountId: 'a2' }),
      trade('other-instrument', { instrumentId: 'i2' }),
      trade('other-side', { side: 'sell' }),
    ],
  })

  expect(res).toEqual({ kind: 'none' })
})

// Порядок кандидатов не должен зависеть от того, в каком порядке их отдала база:
// иначе список на подтверждение прыгает между запросами. Время намеренно
// одинаковое — у сделок из отчёта Сбера оно берётся из даты, и это штатный случай.
it('отдаёт кандидатов в одном порядке при одинаковом времени исполнения', () => {
  const sameMoment = new Date('2026-03-02T10:00:00Z')
  const first = trade('t1', { executedAt: sameMoment })
  const second = trade('t2', { executedAt: sameMoment })

  const direct = matchDecisionToTrades({ decision: base, trades: [first, second] })
  const reversed = matchDecisionToTrades({ decision: base, trades: [second, first] })

  expect(direct).toEqual({ kind: 'ambiguous', tradeIds: ['t1', 't2'] })
  expect(reversed).toEqual(direct)
})
