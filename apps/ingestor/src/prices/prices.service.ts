import { Injectable, Logger } from '@nestjs/common'
import { PRICES_TOPIC } from '@thesis/contracts'
import type { PriceQuoted } from '@thesis/contracts'
import { PrismaService } from '../db/prisma.service.ts'
import { OutboxRepository } from '../outbox/outbox.repository.ts'
import { MoexClient } from './moex.client.ts'

const SOURCE = 'moex'
const DAY_MS = 24 * 60 * 60 * 1000
// Пять лет дневных закрытий — около 1250 точек на бумагу. Отчёт брокера
// отдаёт максимум год за выгрузку, но сделки руками бывают и старше.
const HISTORY_DAYS = 5 * 365
// Начало окна может попасть на выходные: требовать цену ровно в этот день
// значит просить историю заново каждый раз.
const GRACE_MS = 7 * DAY_MS

@Injectable()
export class PricesService {
  private readonly log = new Logger(PricesService.name)
  // Бумаги, по которым в этом процессе историю уже пытались получить. Без
  // этого бумага, появившаяся на бирже позже начала окна, запрашивается
  // каждый цикл вечно.
  private readonly attempted = new Set<string>()

  constructor(
    private readonly prisma: PrismaService,
    private readonly moex: MoexClient,
    private readonly outbox: OutboxRepository,
  ) {}

  // Цена и событие о ней — одной транзакцией. createManyAndReturn вместо
  // createMany не ради возврата: он говорит, какие строки **действительно**
  // вставились, и события уходят только за них. С createMany дубли из
  // skipDuplicates породили бы события о том, что уже публиковалось.
  private async store(
    rows: { instrumentId: string; symbol: string; price: string; quotedAt: Date }[],
  ): Promise<number> {
    if (rows.length === 0) return 0

    return this.prisma.$transaction(async (tx) => {
      const inserted = await tx.providerPrice.createManyAndReturn({
        data: rows.map(({ instrumentId, price, quotedAt }) => ({
          instrumentId,
          source: SOURCE,
          price,
          quotedAt,
        })),
        skipDuplicates: true,
        select: { instrumentId: true, price: true, quotedAt: true },
      })

      const symbols = new Map(rows.map((row) => [row.instrumentId, row.symbol]))
      await this.outbox.enqueue(
        tx,
        inserted.map((row) => ({
          topic: PRICES_TOPIC,
          // Ключ — тикер: он выбирает партицию и тем задаёт порядок цен одной
          // бумаги.
          key: symbols.get(row.instrumentId) ?? row.instrumentId,
          payload: {
            instrumentId: row.instrumentId,
            symbol: symbols.get(row.instrumentId) ?? '',
            source: SOURCE,
            price: row.price.toString(),
            quotedAt: row.quotedAt.toISOString(),
          } satisfies PriceQuoted,
        })),
      )
      return inserted.length
    })
  }

  // Отбор идёт по справочнику инструментов: он заполняется фактом сделки, то
  // есть вопрос «какие котировки нам нужны» уже отвечен покупкой. Справочник
  // живёт в схеме api, и воркер читает его с правом только на select —
  // единственное исключение из «только своя схема», см. docs/unknowns.md.
  async refresh(): Promise<{ saved: number; seen: number }> {
    const instruments = await this.prisma.instrument.findMany({
      where: { class: 'equity' },
      select: { id: true, symbol: true },
    })
    if (instruments.length === 0) return { saved: 0, seen: 0 }

    const quotes = await this.moex.quotes()
    const wanted = new Map(instruments.map((item) => [item.symbol, item.id]))

    const rows = quotes.flatMap((quote) => {
      const instrumentId = wanted.get(quote.symbol)
      return instrumentId ? [{ instrumentId, ...quote }] : []
    })

    // skipDuplicates внутри store: вне торгов ISS отдаёт ту же quoted_at, и
    // повторный прогон не должен ни падать, ни писать второй раз. Торговый
    // календарь поэтому и не нужен.
    return { saved: await this.store(rows), seen: quotes.length }
  }

  // Пятиминутный опрос копит только «сегодня», а сделки в отчёте брокера
  // бывают многолетней давности: без истории все они слипаются в одну точку
  // графика. Дневные закрытия закрывают разрыв — один раз на бумагу.
  async backfill(): Promise<{ filled: number; saved: number }> {
    const instruments = await this.prisma.instrument.findMany({
      where: { class: 'equity' },
      select: { id: true, symbol: true },
    })
    const from = new Date(Date.now() - HISTORY_DAYS * DAY_MS)
    let filled = 0
    let saved = 0

    for (const instrument of instruments) {
      if (this.attempted.has(instrument.symbol)) continue
      const first = await this.prisma.providerPrice.findFirst({
        where: { instrumentId: instrument.id },
        orderBy: { quotedAt: 'asc' },
        select: { quotedAt: true },
      })
      // Есть цена не новее начала окна — история закрыта. У бумаги, которая
      // появилась на бирже позже, этого не случится никогда, и от вечных
      // запросов спасает только память процесса.
      if (first && first.quotedAt.getTime() <= from.getTime() + GRACE_MS) continue

      const closes = await this.moex.history(instrument.symbol, from)
      // Отметка ставится после ответа, а не до: сорвавшийся запрос нужно
      // повторить в следующем цикле, пустой ответ — нет.
      this.attempted.add(instrument.symbol)
      if (closes.length === 0) {
        this.log.warn(`истории по ${instrument.symbol} на доске нет`)
        continue
      }

      saved += await this.store(
        closes.map(({ price, quotedAt }) => ({
          instrumentId: instrument.id,
          symbol: instrument.symbol,
          price,
          quotedAt,
        })),
      )
      filled += 1
    }
    return { filled, saved }
  }
}
