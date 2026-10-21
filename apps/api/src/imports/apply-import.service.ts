import { BadRequestException, ConflictException, Injectable } from '@nestjs/common'
import { Money } from '@thesis/contracts'
import { PrismaService } from '../db/prisma.service.ts'
import { MatchingService } from '../decisions/matching.service.ts'
import { InstrumentsService } from '../instruments/instruments.service.ts'
import { TradesService } from '../trades/trades.service.ts'
import { parseSberXlsx } from './parsers/sber-xlsx.ts'
import type { InstrumentClass, RawOperation } from './parsers/sber-xlsx.ts'

export type ImportResult = { created: number; skipped: number }

// Отдельный тип, а не просто ConflictException: проигравший гонку не сделал
// работы, и в catch его надо отличить от настоящей неудачи импорта — иначе
// отчёт победителя пометится как провалившийся.
export class ImportAlreadyRunning extends ConflictException {
  constructor() {
    super({ status: 'already_running' })
  }
}

const ZERO = Money.of('0')

// Парсер гарантирует эти поля у сделки, но в `RawOperation` они опциональны —
// у денежной операции их нет. Сужаем один раз, чтобы дальше в коде не было
// восклицательных знаков на каждом поле.
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

// Парсер отдаёт операции в порядке файла — от новых к старым. Применять надо
// от старых к новым, иначе продажа встретит лоты, которых ещё нет. Второй ключ
// сортировки нужен для операций, совпавших до секунды: без него повторный
// импорт мог бы разложить их иначе.
function inOrder<T extends { executedAt: string; externalId: string }>(operations: T[]): T[] {
  return operations.toSorted(
    (a, b) => a.executedAt.localeCompare(b.executedAt) || a.externalId.localeCompare(b.externalId),
  )
}

// Инструмент создаётся для каждого тикера до транзакции, поэтому промах карты
// означает ошибку в коде, а не отсутствие данных: пустая строка уехала бы в
// ::uuid и упала бы в базе непонятным сообщением.
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

  // userId есть в сигнатуре, хотя в плане его не было: без него не прочитать
  // ни сам импорт, ни счёт — RLS их просто не покажет.
  async run(userId: string, importId: string): Promise<ImportResult> {
    const { raw, account } = await this.prisma.withUser(userId, async (tx) => {
      const found = await tx.rawImport.findUniqueOrThrow({ where: { id: importId } })
      return {
        raw: found,
        account: await tx.account.findUniqueOrThrow({ where: { id: found.accountId } }),
      }
    })

    if (raw.source !== 'sber') {
      throw new BadRequestException(`источник «${raw.source}» пока не разбирается`)
    }

    try {
      const operations = await parseSberXlsx(Buffer.from(raw.payload))
      const trades = inOrder(operations.filter((op) => op.kind === 'trade').map(asTrade))
      const cash = inOrder(operations.filter((op) => op.kind === 'cash').map(asCash))

      // Справочник инструментов общий и без RLS, поэтому upsert идёт до
      // импортной транзакции: внутри она держала бы блокировку на общей
      // таблице весь импорт. Откат оставит инструмент без сделок — безвредно.
      const instrumentIds = await this.resolveInstruments(trades)
      await this.assertSellsCovered(userId, raw.accountId, account.provider, trades, instrumentIds)

      const applied: string[] = []
      let created = 0
      let skipped = 0

      await this.prisma.withUser(userId, async (tx) => {
        // `try`, а не блокирующий `pg_advisory_xact_lock`: второй импорт должен
        // получить отказ сразу, а не встать в очередь и повторить работу,
        // которую уже делает первый. Блокировка транзакционная — снимается
        // на коммите или откате сама, освободить её вручную невозможно забыть.
        //
        // Ключ — счёт, а не импорт: два разных отчёта по одному счёту
        // одновременно опасны так же, у них пересекаются лоты и позиции.
        // `hashtext` даёт int4, и коллизия двух счётов обойдётся лишним
        // отказом, а не потерянными данными.
        const [lock] = await tx.$queryRaw<{ locked: boolean }[]>`
          select pg_try_advisory_xact_lock(hashtext(${`import:${raw.accountId}`})) as locked
        `
        if (!lock?.locked) throw new ImportAlreadyRunning()

        for (const operation of trades) {
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
          // Тот же ключ идемпотентности, что у сделок, и та же причина
          // вставлять одним оператором: повторная заливка не должна
          // задваивать деньги.
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

        await tx.rawImport.update({
          where: { id: importId },
          data: { status: 'parsed', error: null },
        })
      })

      // После коммита и по одной сделке: матчинг — отдельная работа, его
      // ошибка не должна откатывать принятый отчёт.
      for (const tradeId of applied) await this.matching.matchTrade(userId, tradeId)

      return { created, skipped }
    } catch (error) {
      // Проигравший гонку ничего не записал, и помечать импорт неудачным
      // нельзя: его как раз применяет победитель.
      if (error instanceof ImportAlreadyRunning) throw error

      // Своей транзакцией: импортная уже откачена, и вместе с ней откатилась
      // бы отметка о неудаче.
      await this.prisma.withUser(userId, (tx) =>
        tx.rawImport.update({
          where: { id: importId },
          data: { status: 'failed', error: error instanceof Error ? error.message : String(error) },
        }),
      )
      throw error
    }
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

  // Период отчёта может начинаться позже покупок: тогда под продажу нет лотов,
  // consumeFifo бросит «not enough quantity», и при одной транзакции на отчёт
  // не применится вообще ничего. Проверяем заранее, чтобы назвать все тикеры
  // сразу и сказать, сколько именно не хватает, — иначе человеку нечего
  // делать с ошибкой. Решение и отвергнутые варианты — docs/unknowns.md,
  // «Продажа, под которую в периоде выгрузки нет покупок».
  private async assertSellsCovered(
    userId: string,
    accountId: string,
    provider: string,
    trades: TradeOperation[],
    instrumentIds: Map<string, string>,
  ): Promise<void> {
    const { lots, imported } = await this.prisma.withUser(userId, async (tx) => ({
      lots: await tx.lot.findMany({
        where: { accountId, qtyRemaining: { gt: '0' } },
        select: { instrumentId: true, qtyRemaining: true },
      }),
      // Уже импортированные сделки повторно не применятся, и считать их в
      // балансе нельзя: иначе повторный импорт продажи выглядел бы как
      // непокрытый, хотя лоты под неё уже списаны.
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

    const missing = new Map<string, Money>()
    for (const operation of trades) {
      if (seen.has(operation.externalId)) continue
      const instrumentId = instrumentOf(instrumentIds, operation.ticker)
      const quantity = Money.of(operation.quantity)
      const before = held.get(instrumentId) ?? ZERO

      if (operation.side === 'buy') {
        held.set(instrumentId, before.plus(quantity))
        continue
      }
      if (before.lt(quantity)) {
        const gap = quantity.minus(before)
        missing.set(operation.ticker, (missing.get(operation.ticker) ?? ZERO).plus(gap))
      }
      held.set(instrumentId, before.minus(quantity))
    }

    if (missing.size === 0) return

    const listed = [...missing].map(([ticker, gap]) => `${ticker} — ${gap.toString()}`).join(', ')
    throw new BadRequestException(
      `в отчёте есть продажи без покупок: ${listed}. ` +
        'Добавьте открывающую покупку вручную — её цену знаете только вы — ' +
        'или закажите выгрузку с даты открытия счёта и повторите импорт: дубли не появятся.',
    )
  }
}
