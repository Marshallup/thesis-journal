import { BadRequestException, Injectable } from '@nestjs/common'
import { Money } from '@thesis/contracts'
import { PrismaService } from '../db/prisma.service.ts'
import { PricesService } from '../prices/prices.service.ts'
import { ContextSnapshotService } from './context-snapshot.service.ts'
import type { CreateDecision, ReviseDecision } from './dto.ts'
import { MatchingService } from './matching.service.ts'

const DAY_MS = 24 * 60 * 60 * 1000

// Чем кончилось решение. Считается на чтении: исход меняется с каждой сделкой
// и с каждой котировкой, а хранимый производный показатель разъезжается — та
// же причина, по которой не хранится средняя цена.
export type DecisionOutcome = {
  realizedPnl: string
  // null, когда по открытому остатку нет цены: итога тогда не существует.
  unrealizedPnl: string | null
  totalPnl: string | null
  // Остаток лотов, открытых сделками этого решения.
  openQuantity: string
  // Сколько дней горизонта осталось; отрицательное — истёк.
  daysLeft: number
}

@Injectable()
export class DecisionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly matching: MatchingService,
    private readonly snapshots: ContextSnapshotService,
    private readonly prices: PricesService,
  ) {}

  // Ручная привязка пачкой с экрана разметки. Окно горизонта здесь не
  // проверяется — решает человек, — но счёт, бумага и сторона обязаны
  // совпадать: иначе это опечатка, а не выбор.
  linkTrades(userId: string, decisionId: string, tradeIds: string[]) {
    return this.prisma.withUser(userId, async (tx) => {
      // RLS не покажет чужое решение, и findUniqueOrThrow даст 404 вместо
      // молчаливого нуля привязок.
      const decision = await tx.decision.findUniqueOrThrow({ where: { id: decisionId } })
      const trades = await tx.trade.findMany({ where: { id: { in: tradeIds } } })

      const missing = tradeIds.filter((id) => !trades.some((trade) => trade.id === id))
      if (missing.length > 0)
        throw new BadRequestException(`сделки не найдены: ${missing.join(', ')}`)

      const foreign = trades.filter(
        (trade) =>
          trade.accountId !== decision.accountId ||
          trade.instrumentId !== decision.instrumentId ||
          trade.side !== decision.side,
      )
      if (foreign.length > 0) {
        throw new BadRequestException(
          `сделки не подходят решению по счёту, инструменту или направлению: ${foreign
            .map((trade) => trade.id)
            .join(', ')}`,
        )
      }

      let linked = 0
      let skipped = 0
      for (const trade of trades) {
        // ON CONFLICT по уникальному (trade_id): одна сделка исполняет одно
        // решение. Повторная привязка — не ошибка, а «уже привязана».
        const inserted = await tx.$queryRaw<{ id: string }[]>`
          insert into decision_trades (account_id, decision_id, trade_id)
          values (${decision.accountId}::uuid, ${decisionId}::uuid, ${trade.id}::uuid)
          on conflict (trade_id) do nothing
          returning id
        `
        if (inserted[0]) linked += 1
        else skipped += 1
      }
      return { linked, skipped }
    })
  }

  async create(userId: string, dto: CreateDecision) {
    // Снимок делает сервер в момент записи, а не клиент: иначе его можно
    // подделать, а он нужен именно как неподменяемый контекст решения.
    const context = await this.snapshots.build(userId, dto.accountId, dto.instrumentId, new Date())

    const decision = await this.prisma.withUser(userId, async (tx) => {
      // Явный фильтр по userId, RLS под ним — второй рубеж. Заодно проверка
      // владения счётом: чужой не найдётся.
      await tx.account.findFirstOrThrow({ where: { id: dto.accountId, userId } })
      // Поля выписаны явно: при exactOptionalPropertyTypes пропущенное поле и
      // пустое значение — разные вещи, и для базы это null, а не undefined.
      return tx.decision.create({
        data: {
          accountId: dto.accountId,
          instrumentId: dto.instrumentId,
          side: dto.side,
          thesis: dto.thesis,
          horizonDays: dto.horizonDays,
          conviction: dto.conviction,
          mood: dto.mood,
          postFactum: dto.postFactum ?? false,
          invalidator: dto.invalidator ?? null,
          tags: dto.tags ?? [],
          freeText: dto.freeText ?? null,
          contextSnapshot: context,
        },
      })
    })

    // Срабатывает редко — сделка обязана быть позже решения, — но вызов
    // предусмотрен планом и служит точкой повторного прогона.
    await this.matching.matchDecision(userId, decision.id)
    return decision
  }

  // Исходное решение не трогаем — его защищает триггер. Правка это новая строка
  // с полным снимком, и снимок берётся от действующего состояния: иначе правка
  // одного поля обнулила бы остальные.
  revise(userId: string, id: string, dto: ReviseDecision) {
    return this.prisma.withUser(userId, async (tx) => {
      const decision = await tx.decision.findUniqueOrThrow({ where: { id } })
      await tx.account.findFirstOrThrow({ where: { id: decision.accountId, userId } })

      const latest = await tx.decisionRevision.findFirst({
        where: { decisionId: id },
        orderBy: { createdAt: 'desc' },
      })
      const current = latest ?? decision

      return tx.decisionRevision.create({
        data: {
          accountId: decision.accountId,
          decisionId: id,
          thesis: dto.thesis ?? current.thesis,
          horizonDays: dto.horizonDays ?? current.horizonDays,
          conviction: dto.conviction ?? current.conviction,
          mood: dto.mood ?? current.mood,
          invalidator: dto.invalidator ?? current.invalidator,
          tags: dto.tags ?? current.tags,
          freeText: dto.freeText ?? current.freeText,
        },
      })
    })
  }

  // Действующее состояние — последняя ревизия, если она есть. История отдаётся
  // целиком: в ней и смысл дневника, а не только в текущей редакции.
  async list(userId: string) {
    const { decisions, realized, openLots } = await this.prisma.withUser(userId, async (tx) => ({
      decisions: await tx.decision.findMany({
        orderBy: { createdAt: 'desc' },
        include: {
          revisions: { orderBy: { createdAt: 'desc' } },
          // decision_trades и trades принадлежат одному сервису core, поэтому
          // связь между ними настоящая и include здесь законен.
          trades: { include: { trade: true }, orderBy: { createdAt: 'asc' } },
        },
      }),

      // Списание относится к решению, если решению принадлежит сделка с любой
      // его стороны: покупка, открывшая лот, или продажа, его закрывшая. Для
      // решения купить это судьба открытых им лотов, для решения продать —
      // результат самой продажи.
      //
      // distinct обязателен: когда обе сделки принадлежат одному решению,
      // join нашёл бы списание дважды и удвоил результат.
      realized: await tx.$queryRaw<{ decisionId: string; realizedPnl: string }[]>`
        with touched as (
          select distinct dt.decision_id, c.id, c.realized_pnl
            from lot_consumptions c
            join lots l on l.id = c.lot_id
            join decision_trades dt on dt.trade_id in (c.trade_id, l.open_trade_id)
        )
        select decision_id as "decisionId", sum(realized_pnl)::text as "realizedPnl"
          from touched
         group by decision_id
      `,

      // Открытые лоты решения. Цена присоединяется ниже, в TypeScript: там же,
      // где у портфеля, чтобы «цены нет» значило везде одно и то же.
      openLots: await tx.$queryRaw<
        {
          decisionId: string
          instrumentId: string
          qtyRemaining: string
          costRemaining: string
        }[]
      >`
        select dt.decision_id as "decisionId",
               l.instrument_id as "instrumentId",
               l.qty_remaining::text as "qtyRemaining",
               l.cost_remaining::text as "costRemaining"
          from lots l
          join decision_trades dt on dt.trade_id = l.open_trade_id
         where l.qty_remaining > 0
      `,
    }))

    const prices = new Map((await this.prices.latest()).map((row) => [row.instrumentId, row.price]))
    const realizedOf = new Map(realized.map((row) => [row.decisionId, row.realizedPnl]))
    const zero = Money.of('0')
    const now = Date.now()

    return decisions.map((decision) => {
      const lots = openLots.filter((lot) => lot.decisionId === decision.id)
      let unrealized = zero
      let quantity = zero
      let priced = true

      for (const lot of lots) {
        quantity = quantity.plus(lot.qtyRemaining)
        const price = prices.get(lot.instrumentId)
        if (!price) {
          priced = false
          continue
        }
        unrealized = unrealized.plus(
          Money.of(lot.qtyRemaining).times(price).minus(lot.costRemaining),
        )
      }

      const result = Money.of(realizedOf.get(decision.id) ?? '0')
      const outcome: DecisionOutcome = {
        realizedPnl: result.toString(),
        unrealizedPnl: priced ? unrealized.toString() : null,
        totalPnl: priced ? result.plus(unrealized).toString() : null,
        openQuantity: quantity.toString(),
        daysLeft: decision.horizonDays - Math.floor((now - decision.createdAt.getTime()) / DAY_MS),
      }
      return { ...decision, outcome }
    })
  }
}
