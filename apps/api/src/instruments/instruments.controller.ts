import { Controller, Get, UseGuards } from '@nestjs/common'
import { AuthGuard } from '@nestjs/passport'
import { ApiBearerAuth, ApiOperation } from '@nestjs/swagger'
import type { Prisma } from '@thesis/db'
import { PrismaService } from '../db/prisma.service.ts'

// Справочник общий для всех пользователей, политик RLS на нём нет, поэтому
// withUser здесь не нужен. Владельцем таблицы по design.md:74 станет ingestor —
// тогда этот маршрут уедет туда, а веб будет ходить через API сервиса.
@Controller('instruments')
@UseGuards(AuthGuard('jwt'))
@ApiBearerAuth()
export class InstrumentsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @ApiOperation({ summary: 'Справочник инструментов' })
  // Тип выписан явно: выведенный ссылается на внутренние файлы генерата
  // Prisma, и TypeScript справедливо считает такой тип непортабельным (TS2883).
  list(): Promise<Prisma.InstrumentModel[]> {
    return this.prisma.instrument.findMany({ orderBy: { symbol: 'asc' } })
  }
}
