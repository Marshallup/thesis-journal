import { BadRequestException, Injectable } from '@nestjs/common'
import { Money } from '@thesis/contracts'
import type { Prisma } from '@thesis/db'
import { PrismaService } from '../db/prisma.service.ts'
import { MatchingService } from '../decisions/matching.service.ts'
import { consumeFifo } from './domain/fifo.ts'
import type { ApplyTrade } from './dto.ts'

const ZERO = Money.of('0')

// У импортированной сделки есть номер из отчёта, у ручной external_id — NULL.
export type ApplyInput = ApplyTrade & { provider: string; externalId: string | null }

// Только эти два поля: читать счёт на каждую строку отчёта незачем.
type TradeAccount = { id: string; baseCurrency: string }

@Injectable()
export class TradesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly matching: MatchingService,
  ) {}

  // `linked: false` — без привязанного решения. Фильтрует база: после импорта
  // за год таких сделок десятки.
  list(userId: string, options: { linked?: boolean } = {}) {
    return this.prisma.withUser(userId, (tx) =>
      tx.trade.findMany({
        where: options.linked === false ? { decisions: { none: {} } } : {},
        orderBy: { executedAt: 'desc' },
      }),
    )
  }

  async apply(userId: string, dto: ApplyTrade) {
    const applied = await this.prisma.withUser(userId, async (tx) => {
      // Фильтр по userId явный, RLS под ним — второй рубеж. Заодно это и
      // проверка владения счётом: чужой просто не найдётся.
      const account = await tx.account.findFirstOrThrow({ where: { id: dto.accountId, userId } })
      const inserted = await this.applyWithin(tx, account, {
        ...dto,
        provider: 'manual',
        externalId: null,
      })
      // NULL-ы в уникальном индексе различны, значит ручная сделка не
      // конфликтует никогда. Пустой ответ означал бы сломанный индекс.
      if (!inserted) throw new Error('manual trade cannot conflict: external_id is null')

      // Вставка возвращает id, а контроллеру нужна модель: $queryRaw отдал бы
      // колонки в snake_case.
      return tx.trade.findUniqueOrThrow({ where: { id: inserted.id } })
    })

    // После транзакции: непривязанную сделку можно разметить позже,
    // незаписанную — восстановить нечем.
    await this.matching.matchTrade(userId, applied.id)
    return applied
  }

  // Принимает готовую транзакцию: импорт применяет весь отчёт одной. Сделка,
  // лоты и позиция меняются вместе, иначе остатки разойдутся с позицией.
  // null — сделка уже есть; матчинг остаётся на вызывающем.
  async applyWithin(
    tx: Prisma.TransactionClient,
    account: TradeAccount,
    input: ApplyInput,
  ): Promise<{ id: string } | null> {
    const quantity = Money.of(input.quantity)
    if (quantity.eq(ZERO)) throw new BadRequestException('quantity must be positive')
    const price = Money.of(input.price)
    const fee = Money.of(input.fee)
    const executedAt = new Date(input.executedAt)

    // ON CONFLICT, а не create: повторная заливка — штатный случай, а create
    // на конфликте бросает. Ноль строк значит «уже импортирована».
    const inserted = await tx.$queryRaw<{ id: string }[]>`
      insert into trades
        (account_id, instrument_id, side, quantity, price,
         fee, fee_currency, executed_at, provider, external_id)
      values (
        ${input.accountId}::uuid, ${input.instrumentId}::uuid, ${input.side},
        ${input.quantity}::numeric, ${input.price}::numeric,
        ${input.fee}::numeric, ${account.baseCurrency}, ${executedAt},
        ${input.provider}, ${input.externalId}
      )
      on conflict (account_id, provider, external_id) do nothing
      returning id
    `
    const trade = inserted[0]
    if (!trade) return null

    if (input.side === 'buy') {
      // Комиссия покупки входит в затраты лота — делить её на единицы при
      // каждом списании не придётся.
      const cost = quantity.times(price).plus(fee)
      await tx.lot.create({
        data: {
          accountId: input.accountId,
          instrumentId: input.instrumentId,
          openTradeId: trade.id,
          qtyOpen: input.quantity,
          qtyRemaining: input.quantity,
          price: input.price,
          costOpen: cost.toString(),
          costRemaining: cost.toString(),
          openedAt: executedAt,
        },
      })
      await this.movePosition(tx, input, quantity, cost, ZERO)
      return trade
    }

    const open = await tx.lot.findMany({
      where: {
        accountId: input.accountId,
        instrumentId: input.instrumentId,
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
          accountId: input.accountId,
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
    await this.movePosition(tx, input, ZERO.minus(quantity), ZERO.minus(soldCost), realized)
    return trade
  }

  // Одним оператором: «сначала SELECT, потом INSERT» даёт гонку двух первых
  // сделок по инструменту. Прибавляются дельты, поэтому порядок не важен.
  private movePosition(
    tx: Prisma.TransactionClient,
    input: Pick<ApplyInput, 'accountId' | 'instrumentId'>,
    quantity: Money,
    cost: Money,
    realized: Money,
  ) {
    return tx.$executeRaw`
      insert into positions
        (account_id, instrument_id, quantity, cost_basis_total, realized_pnl, updated_at)
      values (
        ${input.accountId}::uuid, ${input.instrumentId}::uuid,
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
