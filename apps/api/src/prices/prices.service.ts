import { Injectable } from '@nestjs/common'
import type { Prisma } from '@thesis/db'
import { PrismaService } from '../db/prisma.service.ts'

// Только чтение. Опрос биржи уехал в ingestor (задача 19c), и
// `public.instrument_prices` стала проекцией: её наполняет консьюмер событий
// (задача 19e), а api на неё только смотрит.
@Injectable()
export class PricesService {
  constructor(private readonly prisma: PrismaService) {}

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
