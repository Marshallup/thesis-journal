import { Injectable, Logger } from '@nestjs/common'
import type { Prisma } from '@thesis/db'
import { PrismaService } from '../db/prisma.service.ts'
import { MoexClient } from './moex.client.ts'

export type Quote = { instrumentId: string; price: string; quotedAt: Date }

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
  // этого делистованная бумага, которой на доске нет, запрашивается каждый
  // цикл вечно.
  private readonly attempted = new Set<string>()

  constructor(
    private readonly prisma: PrismaService,
    private readonly moex: MoexClient,
  ) {}

  // Отбор идёт по справочнику инструментов, а не по позициям: справочник
  // заполняется фактом сделки, а positions закрыт RLS и планировщику без
  // пользователя не виден. Цены и справочник — общие данные, позиции — личные.
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
      return instrumentId ? [{ instrumentId, source: SOURCE, ...quote }] : []
    })
    if (rows.length === 0) return { saved: 0, seen: quotes.length }

    // skipDuplicates: вне торгов ISS отдаёт ту же quoted_at, и повторный прогон
    // не должен ни падать, ни писать второй раз. Торговый календарь не нужен.
    const { count } = await this.prisma.instrumentPrice.createMany({
      data: rows.map(({ instrumentId, price, quotedAt }) => ({
        instrumentId,
        source: SOURCE,
        price,
        quotedAt,
      })),
      skipDuplicates: true,
    })
    return { saved: count, seen: quotes.length }
  }

  // Пятиминутный опрос копит только «сегодня», а сделки в отчёте брокера
  // бывают многолетней давности: без истории все они слипаются в одну точку.
  // Дневные закрытия закрывают разрыв — один раз на бумагу.
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
      const first = await this.prisma.instrumentPrice.findFirst({
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
      const { count } = await this.prisma.instrumentPrice.createMany({
        data: closes.map(({ price, quotedAt }) => ({
          instrumentId: instrument.id,
          source: SOURCE,
          price,
          quotedAt,
        })),
        skipDuplicates: true,
      })
      filled += 1
      saved += count
    }
    return { filled, saved }
  }

  // Последняя цена на инструмент — max(quoted_at). Опоздавшая точка лежит в
  // истории и на этот ответ не влияет.
  latest(): Promise<{ instrumentId: string; price: string; quotedAt: Date }[]> {
    return this.prisma.$queryRaw`
      select distinct on (instrument_id)
             instrument_id as "instrumentId",
             price::text,
             quoted_at as "quotedAt"
        from instrument_prices
       order by instrument_id, quoted_at desc
    `
  }

  // Тип выписан явно: выведенный ссылается на внутренние файлы генерата Prisma,
  // и TypeScript справедливо считает такой тип непортабельным (TS2883).
  history(instrumentId: string, from: Date): Promise<{ price: Prisma.Decimal; quotedAt: Date }[]> {
    return this.prisma.instrumentPrice.findMany({
      where: { instrumentId, quotedAt: { gte: from } },
      orderBy: { quotedAt: 'asc' },
      select: { price: true, quotedAt: true },
    })
  }
}
