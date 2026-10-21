import { BadRequestException, Injectable } from '@nestjs/common'
import { Money } from '@thesis/contracts'
import type { Prisma } from '@thesis/db'
import { PrismaService } from '../db/prisma.service.ts'
import { MatchingService } from '../decisions/matching.service.ts'
import { consumeFifo } from './domain/fifo.ts'
import type { ApplyTrade } from './dto.ts'

const ZERO = Money.of('0')

@Injectable()
export class TradesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly matching: MatchingService,
  ) {}

  list(userId: string) {
    return this.prisma.withUser(userId, (tx) =>
      tx.trade.findMany({ orderBy: { executedAt: 'desc' } }),
    )
  }

  // Всё в одной транзакции: сделка, лоты и позиция обязаны измениться вместе,
  // иначе сумма остатков лотов разойдётся с позицией.
  async apply(userId: string, dto: ApplyTrade) {
    const quantity = Money.of(dto.quantity)
    if (quantity.eq(ZERO)) throw new BadRequestException('quantity must be positive')
    const price = Money.of(dto.price)
    const fee = Money.of(dto.fee)
    const executedAt = new Date(dto.executedAt)

    const applied = await this.prisma.withUser(userId, async (tx) => {
      // Фильтр по userId явный, RLS под ним — второй рубеж. Заодно это и
      // проверка владения счётом: чужой просто не найдётся.
      const account = await tx.account.findFirstOrThrow({ where: { id: dto.accountId, userId } })

      const trade = await tx.trade.create({
        data: {
          accountId: dto.accountId,
          instrumentId: dto.instrumentId,
          side: dto.side,
          quantity: dto.quantity,
          price: dto.price,
          fee: dto.fee,
          feeCurrency: account.baseCurrency,
          executedAt,
          provider: 'manual',
        },
      })

      if (dto.side === 'buy') {
        // Комиссия покупки входит в затраты лота — делить её на единицы при
        // каждом списании не придётся.
        const cost = quantity.times(price).plus(fee)
        await tx.lot.create({
          data: {
            accountId: dto.accountId,
            instrumentId: dto.instrumentId,
            openTradeId: trade.id,
            qtyOpen: dto.quantity,
            qtyRemaining: dto.quantity,
            price: dto.price,
            costOpen: cost.toString(),
            costRemaining: cost.toString(),
            openedAt: executedAt,
          },
        })
        await this.movePosition(tx, dto, quantity, cost, ZERO)
        return trade
      }

      const open = await tx.lot.findMany({
        where: {
          accountId: dto.accountId,
          instrumentId: dto.instrumentId,
          qtyRemaining: { gt: '0' },
        },
      })
      const { consumptions } = consumeFifo(
        open.map((lot) => ({
          id: lot.id,
          qty: Money.of(lot.qtyRemaining.toString()),
          cost: Money.of(lot.costRemaining.toString()),
          openedAt: lot.openedAt,
        })),
        quantity,
        price,
        fee,
      )

      for (const consumption of consumptions) {
        await tx.lotConsumption.create({
          data: {
            accountId: dto.accountId,
            lotId: consumption.lotId,
            tradeId: trade.id,
            qty: consumption.qty.toString(),
            cost: consumption.cost.toString(),
            realizedPnl: consumption.realizedPnl.toString(),
          },
        })
        // Относительное обновление, а не чтение с записью: иначе две продажи
        // по одному лоту затрут друг друга.
        await tx.lot.update({
          where: { id: consumption.lotId },
          data: {
            qtyRemaining: { decrement: consumption.qty.toString() },
            costRemaining: { decrement: consumption.cost.toString() },
          },
        })
      }

      const soldCost = consumptions.reduce((acc, c) => acc.plus(c.cost), ZERO)
      const realized = consumptions.reduce((acc, c) => acc.plus(c.realizedPnl), ZERO)
      await this.movePosition(tx, dto, ZERO.minus(quantity), ZERO.minus(soldCost), realized)
      return trade
    })

    // После транзакции, а не внутри: ошибка матчинга не должна отменять
    // запись сделки. Непривязанную сделку можно размётить позже, незаписанную
    // восстановить нечем.
    await this.matching.matchTrade(userId, applied.id)
    return applied
  }

  // Одним оператором с ON CONFLICT: «сначала SELECT, потом INSERT» здесь даёт
  // гонку двух первых сделок по одному инструменту. Прибавляются дельты, а не
  // подставляются итоги, поэтому порядок применения не важен.
  private movePosition(
    tx: Prisma.TransactionClient,
    dto: ApplyTrade,
    quantity: Money,
    cost: Money,
    realized: Money,
  ) {
    return tx.$executeRaw`
      insert into positions
        (account_id, instrument_id, quantity, cost_basis_total, realized_pnl, updated_at)
      values (
        ${dto.accountId}::uuid, ${dto.instrumentId}::uuid,
        ${quantity.toString()}::numeric, ${cost.toString()}::numeric,
        ${realized.toString()}::numeric, now()
      )
      on conflict (account_id, instrument_id) do update
      set quantity = positions.quantity + excluded.quantity,
          cost_basis_total = positions.cost_basis_total + excluded.cost_basis_total,
          realized_pnl = positions.realized_pnl + excluded.realized_pnl,
          updated_at = now()
    `
  }
}
