import { Injectable, Logger } from '@nestjs/common'
import type { Prisma } from '@thesis/db'
import { PrismaService } from '../db/prisma.service.ts'
import { MoexClient } from './moex.client.ts'

export type Quote = { instrumentId: string; price: string; quotedAt: Date }

const SOURCE = 'moex'

@Injectable()
export class PricesService {
  private readonly log = new Logger(PricesService.name)

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
