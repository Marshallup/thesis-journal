import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common'
import { AuthGuard } from '@nestjs/passport'
import { ApiBearerAuth, ApiBody, ApiOperation } from '@nestjs/swagger'
import type { Prisma } from '@thesis/db'
import { createInstrumentOpenApiSchema, createInstrumentSchema } from './dto.ts'
import type { CreateInstrument } from './dto.ts'
import { InstrumentsService } from './instruments.service.ts'

type ApiBodySchema = Extract<Parameters<typeof ApiBody>[0], { schema: unknown }>['schema']

// Справочник общий, владельцем таблицы по design.md:74 станет ingestor — тогда
// эти маршруты уедут туда, а веб будет ходить через API сервиса.
@Controller('instruments')
@UseGuards(AuthGuard('jwt'))
@ApiBearerAuth()
export class InstrumentsController {
  constructor(private readonly instruments: InstrumentsService) {}

  @Get()
  @ApiOperation({ summary: 'Справочник инструментов' })
  list(): Promise<Prisma.InstrumentModel[]> {
    return this.instruments.list()
  }

  @Post()
  @ApiOperation({ summary: 'Добавить инструмент. Повтор отдаёт существующий' })
  @ApiBody({ schema: createInstrumentOpenApiSchema as ApiBodySchema })
  create(
    @Body({ schema: createInstrumentSchema }) body: CreateInstrument,
  ): Promise<Prisma.InstrumentModel> {
    return this.instruments.create(body)
  }
}
