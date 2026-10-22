import { Injectable } from '@nestjs/common'
import type { Prisma } from '@thesis/db'
import { PrismaService } from '../db/prisma.service.ts'
import { matchDecisionToTrades } from './domain/matching.ts'
import type { MatchInput, MatchResult } from './domain/matching.ts'

type Side = 'buy' | 'sell'

@Injectable()
export class MatchingService {
  constructor(private readonly prisma: PrismaService) {}

  // Отдельной транзакцией после записи: сделка без тезиса — штатное состояние,
  // а непривязанная сделка это работа, которую можно повторить.
  matchTrade(userId: string, tradeId: string): Promise<MatchResult> {
    return this.prisma.withUser(userId, async (tx) => {
      const trade = await tx.trade.findUniqueOrThrow({ where: { id: tradeId } })
      const open = await tx.decision.findMany({
        where: {
          accountId: trade.accountId,
          instrumentId: trade.instrumentId,
          side: trade.side,
          // Решения, у которых сделки ещё нет.
          trades: { none: {} },
        },
        orderBy: { createdAt: 'asc' },
      })
      const candidates = await this.candidateTrades(tx, trade.accountId, trade.instrumentId)

      for (const decision of open) {
        const result = matchDecisionToTrades({
          decision: toDecisionInput(decision),
          trades: candidates,
        })
        if (result.kind === 'auto' && result.tradeId === trade.id) {
          await this.link(tx, decision.accountId, decision.id, trade.id)
          return result
        }
      }
      return { kind: 'none' }
    })
  }

  // После создания решения. Срабатывает редко: сделка должна быть позже
  // решения, а уже записанная почти всегда раньше.
  matchDecision(userId: string, decisionId: string): Promise<MatchResult> {
    return this.prisma.withUser(userId, async (tx) => {
      const decision = await tx.decision.findUniqueOrThrow({ where: { id: decisionId } })
      const candidates = await this.candidateTrades(tx, decision.accountId, decision.instrumentId)
      const result = matchDecisionToTrades({
        decision: toDecisionInput(decision),
        trades: candidates,
      })

      if (result.kind === 'auto') {
        await this.link(tx, decision.accountId, decision.id, result.tradeId)
      }
      return result
    })
  }

  // Горизонт истёк, сделок нет — это и есть учёт несовершённых решений.
  // Время приходит аргументом, иначе проверить нечем.
  markExpired(userId: string, now: Date): Promise<number> {
    return this.prisma.withUser(
      userId,
      (tx) => tx.$executeRaw`
      update decisions set unrealized = true
      where unrealized = false
        and created_at + make_interval(days => horizon_days) < ${now}
        -- Решение задним числом пишется про уже случившуюся сделку, поэтому
        -- несовершённым быть не может: если сделка не привязана, это пробел
        -- разметки, а не бездействие.
        and post_factum = false
        and not exists (
          select 1 from decision_trades where decision_trades.decision_id = decisions.id
        )
    `,
    )
  }

  private async candidateTrades(
    tx: Prisma.TransactionClient,
    accountId: string,
    instrumentId: string,
  ): Promise<MatchInput['trades']> {
    const rows = await tx.trade.findMany({
      where: { accountId, instrumentId },
      select: {
        id: true,
        accountId: true,
        instrumentId: true,
        side: true,
        executedAt: true,
        decisions: { select: { decisionId: true }, take: 1 },
      },
    })
    return rows.map((row) => ({
      id: row.id,
      accountId: row.accountId,
      instrumentId: row.instrumentId,
      side: row.side as Side,
      executedAt: row.executedAt,
      linkedDecisionId: row.decisions[0]?.decisionId ?? null,
    }))
  }

  private link(
    tx: Prisma.TransactionClient,
    accountId: string,
    decisionId: string,
    tradeId: string,
  ) {
    return tx.decisionTrade.create({ data: { accountId, decisionId, tradeId } })
  }
}

function toDecisionInput(decision: {
  id: string
  accountId: string
  instrumentId: string
  side: string
  createdAt: Date
  horizonDays: number
}): MatchInput['decision'] {
  return {
    id: decision.id,
    accountId: decision.accountId,
    instrumentId: decision.instrumentId,
    side: decision.side as Side,
    createdAt: decision.createdAt,
    horizonDays: decision.horizonDays,
  }
}
