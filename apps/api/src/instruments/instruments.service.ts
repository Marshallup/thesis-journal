import { Injectable } from '@nestjs/common'
import type { Prisma } from '@thesis/db'
import { PrismaService } from '../db/prisma.service.ts'
import { createInstrumentSchema } from './dto.ts'
import type { CreateInstrument } from './dto.ts'

@Injectable()
export class InstrumentsService {
  constructor(private readonly prisma: PrismaService) {}

  // Справочник общий для всех пользователей, политик RLS на нём нет, поэтому
  // withUser здесь не нужен.
  list(): Promise<Prisma.InstrumentModel[]> {
    return this.prisma.instrument.findMany({ orderBy: { symbol: 'asc' } })
  }

  // ON CONFLICT, а не prisma.upsert: тот разворачивается в чтение и запись, и
  // два параллельных импорта одного тикера падают на уникальности — проверено
  // гоночным тестом, разбор в docs/incidents.md. Читаем после вставки: нужен
  // инструмент, а не авторство.
  async create(dto: CreateInstrument): Promise<Prisma.InstrumentModel> {
    // Нормализация повторяется здесь: сервис зовут и из теста, минуя Zod.
    const { symbol, class: klass, currency } = createInstrumentSchema.parse(dto)

    await this.prisma.$executeRaw`
      insert into instruments (symbol, class, currency)
      values (${symbol}, ${klass}, ${currency})
      on conflict (symbol, class) do nothing
    `
    return this.prisma.instrument.findUniqueOrThrow({
      where: { symbol_class: { symbol, class: klass } },
    })
  }
}
