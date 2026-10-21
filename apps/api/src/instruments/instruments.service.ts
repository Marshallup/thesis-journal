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

  // Через upsert по паре (symbol, class), а не «сначала найти, потом создать»:
  // два пользователя могут добавить один тикер одновременно, и проигравший
  // получил бы нарушение уникальности вместо существующего инструмента.
  create(dto: CreateInstrument): Promise<Prisma.InstrumentModel> {
    // Нормализация повторяется здесь: сервис зовут и из теста, минуя Zod.
    const { symbol, class: klass, currency } = createInstrumentSchema.parse(dto)

    return this.prisma.instrument.upsert({
      where: { symbol_class: { symbol, class: klass } },
      create: { symbol, class: klass, currency },
      update: {},
    })
  }
}
