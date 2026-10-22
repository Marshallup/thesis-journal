import { ConflictException, Injectable } from '@nestjs/common'
import { Money } from '@thesis/contracts'
import type { InstrumentClass, RawOperation } from '@thesis/contracts'
import { PrismaService } from '../db/prisma.service.ts'
import { MatchingService } from '../decisions/matching.service.ts'
import { InstrumentsService } from '../instruments/instruments.service.ts'
import { TradesService } from '../trades/trades.service.ts'

// Продажа, под которую ещё нет покупок: ждёт отчёта за прошлый год.
// quantity — размер продажи, missing — чего не хватило: это разные числа.
export type DeferredSale = { ticker: string; quantity: string; missing: string }

// То же плюс поля, которые нужны строке в базе.
type DeferredRow = DeferredSale & {
  instrumentId: string
  externalId: string
  occurredAt: string
}
export type ImportResult = { created: number; skipped: number; deferred: DeferredSale[] }

// Отдельный тип: в catch проигравшего гонку надо отличить от настоящей
// неудачи, иначе отчёт победителя пометится как провалившийся.
export class ImportAlreadyRunning extends ConflictException {
  constructor() {
    super({ status: 'already_running' })
  }
}

const ZERO = Money.of('0')

// У денежной операции этих полей нет, поэтому в RawOperation они опциональны.
// Сужаем один раз, чтобы дальше не было восклицательных знаков.
type TradeOperation = {
  side: 'buy' | 'sell'
  ticker: string
  instrumentClass: InstrumentClass
  quantity: string
  price: string
  fee: string
  currency: string
  executedAt: string
  externalId: string
}

type CashOperation = {
  cashKind: string
  ticker: string | null
  amount: string
  currency: string
  executedAt: string
  externalId: string
}

function asTrade(op: RawOperation): TradeOperation {
  const { side, ticker, instrumentClass, quantity, price, fee } = op
  if (!side || !ticker || !instrumentClass || !quantity || !price || fee === undefined) {
    throw new Error(`сделка ${op.externalId}: парсер не заполнил обязательные поля`)
  }
  return {
    side,
    ticker,
    instrumentClass,
    quantity,
    price,
    fee,
    currency: op.currency,
    executedAt: op.executedAt,
    externalId: op.externalId,
  }
}

function asCash(op: RawOperation): CashOperation {
  if (!op.cashKind || op.amount === undefined) {
    throw new Error(`операция ${op.externalId}: парсер не заполнил вид или сумму`)
  }
  return {
    cashKind: op.cashKind,
    ticker: op.ticker ?? null,
    amount: op.amount,
    currency: op.currency,
    executedAt: op.executedAt,
    externalId: op.externalId,
  }
}

// Парсер отдаёт операции от новых к старым, а применять надо наоборот:
// иначе продажа встретит лоты, которых ещё нет. Второй ключ — для совпавших
// до секунды, чтобы повторный импорт разложил их так же.
function inOrder<T extends { executedAt: string; externalId: string }>(operations: T[]): T[] {
  return operations.toSorted(
    (a, b) => a.executedAt.localeCompare(b.executedAt) || a.externalId.localeCompare(b.externalId),
  )
}

// Промах карты — ошибка в коде: инструменты создаются до транзакции.
function instrumentOf(ids: Map<string, string>, ticker: string): string {
  const id = ids.get(ticker)
  if (!id) throw new Error(`инструмент для «${ticker}» не создан`)
  return id
}

@Injectable()
export class ApplyImportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly trades: TradesService,
    private readonly instruments: InstrumentsService,
    private readonly matching: MatchingService,
  ) {}

  // Операции приходят аргументом: разбирает их воркер, а это применение.
  // userId обязателен — без него RLS не покажет ни импорт, ни счёт.
  async apply(userId: string, importId: string, operations: RawOperation[]): Promise<ImportResult> {
    const { raw, account } = await this.prisma.withUser(userId, async (tx) => {
      const found = await tx.import.findUniqueOrThrow({ where: { id: importId } })
      return {
        raw: found,
        account: await tx.account.findUniqueOrThrow({ where: { id: found.accountId } }),
      }
    })

    try {
      const trades = inOrder(operations.filter((op) => op.kind === 'trade').map(asTrade))
      const cash = inOrder(operations.filter((op) => op.kind === 'cash').map(asCash))

      // До транзакции: иначе импорт держал бы блокировку на общей таблице.
      const instrumentIds = await this.resolveInstruments(trades)
      const { deferred, postponed } = await this.splitUncoveredSales(
        userId,
        raw.accountId,
        account.provider,
        trades,
        instrumentIds,
      )

      const applied: string[] = []
      let created = 0
      let skipped = 0

      await this.prisma.withUser(userId, async (tx) => {
        // `try`: второй импорт получает отказ сразу, а не повторяет работу.
        // Транзакционная — снимается сама. Ключ по счёту, а не по импорту:
        // два разных отчёта одного счёта пересекаются по лотам и позициям.
        const [lock] = await tx.$queryRaw<{ locked: boolean }[]>`
          select pg_try_advisory_xact_lock(hashtext(${`import:${raw.accountId}`})) as locked
        `
        if (!lock?.locked) throw new ImportAlreadyRunning()

        for (const operation of trades) {
          if (postponed.has(operation.externalId)) continue

          const trade = await this.trades.applyWithin(tx, account, {
            accountId: raw.accountId,
            instrumentId: instrumentOf(instrumentIds, operation.ticker),
            side: operation.side,
            quantity: operation.quantity,
            price: operation.price,
            fee: operation.fee,
            executedAt: operation.executedAt,
            provider: account.provider,
            externalId: operation.externalId,
          })
          if (!trade) {
            skipped += 1
            continue
          }
          created += 1
          applied.push(trade.id)
        }

        for (const operation of cash) {
          // Ключ идемпотентности тот же, что у сделок.
          const inserted = await tx.$queryRaw<{ id: string }[]>`
            insert into cash_ledger
              (account_id, instrument_id, kind, amount, currency,
               occurred_at, provider, external_id)
            values (
              ${raw.accountId}::uuid,
              ${operation.ticker ? (instrumentIds.get(operation.ticker) ?? null) : null}::uuid,
              ${operation.cashKind}, ${operation.amount}::numeric, ${operation.currency},
              ${new Date(operation.executedAt)}, ${account.provider}, ${operation.externalId}
            )
            on conflict (account_id, provider, external_id) do nothing
            returning id
          `
          if (inserted[0]) created += 1
          else skipped += 1
        }

        // Отложенное — состояние, а не журнал: набор пересчитывается целиком.
        await tx.deferredOperation.deleteMany({ where: { importId } })
        if (deferred.length > 0) {
          await tx.deferredOperation.createMany({
            data: deferred.map((sale) => ({
              accountId: raw.accountId,
              importId,
              instrumentId: sale.instrumentId,
              externalId: sale.externalId,
              side: 'sell',
              quantity: sale.quantity,
              missing: sale.missing,
              occurredAt: new Date(sale.occurredAt),
            })),
          })
        }

        await tx.import.update({
          where: { id: importId },
          data: {
            status: 'parsed',
            error: null,
            // Итог сохраняется, а не возвращается: применение случилось по
            // событию, и спросить «чем кончилось» больше не у кого.
            result: { created, skipped, deferred: deferred.length },
          },
        })
      })

      // После коммита: ошибка матчинга не должна откатывать принятый отчёт.
      for (const tradeId of applied) await this.matching.matchTrade(userId, tradeId)

      return {
        created,
        skipped,
        deferred: deferred.map(({ ticker, quantity, missing }) => ({ ticker, quantity, missing })),
      }
    } catch (error) {
      // Проигравший гонку ничего не записал — метку ставит победитель.
      if (error instanceof ImportAlreadyRunning) throw error

      // Своей транзакцией: импортная уже откачена.
      await this.prisma.withUser(userId, (tx) =>
        tx.import.update({
          where: { id: importId },
          data: { status: 'failed', error: error instanceof Error ? error.message : String(error) },
        }),
      )
      throw error
    }
  }

  // Для экрана импорта: что ждёт покупок и из какого отчёта.
  pending(userId: string) {
    return this.prisma.withUser(userId, (tx) =>
      tx.deferredOperation.findMany({ orderBy: { occurredAt: 'desc' } }),
    )
  }

  private async resolveInstruments(trades: TradeOperation[]): Promise<Map<string, string>> {
    const ids = new Map<string, string>()
    for (const operation of trades) {
      if (ids.has(operation.ticker)) continue
      const instrument = await this.instruments.create({
        symbol: operation.ticker,
        class: operation.instrumentClass,
        currency: operation.currency,
      })
      ids.set(operation.ticker, instrument.id)
    }
    return ids
  }

  // Выгрузка Сбера ограничена годом, поэтому продажа без покупок — штатное
  // состояние первого импорта. Откладываем её, остальное применяем; потери нет,
  // импорт идемпотентен. Разбор — docs/unknowns.md, «Продажа, под которую в
  // периоде выгрузки нет покупок».
  private async splitUncoveredSales(
    userId: string,
    accountId: string,
    provider: string,
    trades: TradeOperation[],
    instrumentIds: Map<string, string>,
  ): Promise<{ deferred: DeferredRow[]; postponed: Set<string> }> {
    const { lots, imported } = await this.prisma.withUser(userId, async (tx) => ({
      lots: await tx.lot.findMany({
        where: { accountId, qtyRemaining: { gt: '0' } },
        select: { instrumentId: true, qtyRemaining: true },
      }),
      // Уже импортированные в баланс не считаем: их лоты уже списаны.
      imported: await tx.trade.findMany({
        where: { accountId, provider },
        select: { externalId: true },
      }),
    }))

    const seen = new Set(imported.map((trade) => trade.externalId))
    const held = new Map<string, Money>()
    for (const lot of lots) {
      const before = held.get(lot.instrumentId) ?? ZERO
      held.set(lot.instrumentId, before.plus(Money.of(lot.qtyRemaining.toString())))
    }

    const deferred: DeferredRow[] = []
    const postponed = new Set<string>()

    for (const operation of trades) {
      if (seen.has(operation.externalId)) continue
      const instrumentId = instrumentOf(instrumentIds, operation.ticker)
      const quantity = Money.of(operation.quantity)
      const before = held.get(instrumentId) ?? ZERO

      if (operation.side === 'buy') {
        held.set(instrumentId, before.plus(quantity))
        continue
      }
      // Откладывается целиком: половина продажи — сделка, которой не было.
      // Остаток не трогаем, он нужен следующим продажам той же бумаги.
      if (before.lt(quantity)) {
        postponed.add(operation.externalId)
        deferred.push({
          ticker: operation.ticker,
          quantity: operation.quantity,
          missing: quantity.minus(before).toString(),
          instrumentId,
          externalId: operation.externalId,
          occurredAt: operation.executedAt,
        })
        continue
      }
      held.set(instrumentId, before.minus(quantity))
    }

    return { deferred, postponed }
  }
}
