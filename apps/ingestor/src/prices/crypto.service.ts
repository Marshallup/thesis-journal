import { Injectable, Logger } from '@nestjs/common'
import { PRICES_TOPIC } from '@thesis/contracts'
import type { PriceQuoted } from '@thesis/contracts'
import { BybitMarket } from '../connectors/bybit/market.ts'
import { OutboxRepository } from '../outbox/outbox.repository.ts'
import { PrismaService } from '../db/prisma.service.ts'

const SOURCE = 'bybit'
const DAY_MS = 24 * 60 * 60 * 1000
// Три года дневных закрытий: глубже выгрузка истории сделок всё равно не
// отдаёт, а оценивать нечего.
const HISTORY_DAYS = 3 * 365

@Injectable()
export class CryptoPricesService {
  private readonly log = new Logger(CryptoPricesService.name)
  // Пары, по которым историю в этом процессе уже пытались получить. Без этого
  // делистнутая пара запрашивается каждый цикл вечно.
  private readonly attempted = new Set<string>()

  constructor(
    private readonly prisma: PrismaService,
    private readonly market: BybitMarket,
    private readonly outbox: OutboxRepository,
  ) {}

  // Цена и событие о ней — одной транзакцией, как у котировок MOEX: проекция в
  // api строится событиями, и цена без события осталась бы невидимой.
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

  // Крипта из справочника: он заполняется фактом сделки, значит вопрос «какие
  // цены нам нужны» уже отвечен покупкой. Справочник живёт в схеме api, и
  // воркер читает его с правом только на select.
  private pairs() {
    return this.prisma.instrument.findMany({
      where: { class: 'crypto' },
      select: { id: true, symbol: true },
    })
  }

  // Текущие цены: один запрос на всю доску, как у MOEX. Пара, которой на
  // бирже нет, молча пропускается — делистнутую монету оценивать нечем, и
  // прочерк честнее последней цены годовой давности.
  async refresh(): Promise<{ saved: number; seen: number }> {
    const pairs = await this.pairs()
    if (pairs.length === 0) return { saved: 0, seen: 0 }

    const tickers = await this.market.tickers()
    const quotedAt = new Date()
    const rows = pairs
      .filter((pair) => tickers.has(pair.symbol))
      .map((pair) => ({
        instrumentId: pair.id,
        symbol: pair.symbol,
        price: tickers.get(pair.symbol)!,
        quotedAt,
      }))

    return { saved: await this.store(rows), seen: pairs.length }
  }

  // История дневных закрытий. Без неё нельзя ни посчитать стоимость портфеля
  // на дату, ни нарисовать график: текущая цена отвечает только на вопрос
  // «сколько сейчас».
  async backfill(): Promise<{ saved: number; filled: number }> {
    const pairs = await this.pairs()
    const from = new Date(Date.now() - HISTORY_DAYS * DAY_MS)
    let saved = 0
    let filled = 0

    for (const pair of pairs) {
      if (this.attempted.has(pair.id)) continue
      this.attempted.add(pair.id)

      const closes = await this.market.dailyCloses(pair.symbol, from)
      if (closes.length === 0) {
        // Делистнутая или неизвестная пара: сказать об этом один раз и не
        // возвращаться — иначе цикл опроса тратит лимит на мёртвые монеты.
        this.log.warn(`${pair.symbol}: истории нет, пара не торгуется`)
        continue
      }

      const written = await this.store(
        closes.map((close) => ({ ...close, instrumentId: pair.id, symbol: pair.symbol })),
      )
      saved += written
      if (written > 0) filled += 1
    }

    return { saved, filled }
  }
}
