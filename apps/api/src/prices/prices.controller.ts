import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common'
import { AuthGuard } from '@nestjs/passport'
import { ApiBearerAuth, ApiOperation } from '@nestjs/swagger'
import { z } from 'zod'
import { PricesService } from './prices.service.ts'

// Девяносто дней по умолчанию: столько влезает в график без прореживания, а
// горизонт решений в журнале обычно короче.
const DEFAULT_DAYS = 90

@Controller('prices')
@UseGuards(AuthGuard('jwt'))
@ApiBearerAuth()
export class PricesController {
  constructor(private readonly prices: PricesService) {}

  @Get(':instrumentId')
  @ApiOperation({ summary: 'История цен инструмента для графика' })
  async history(
    @Param('instrumentId', { schema: z.uuid() }) instrumentId: string,
    @Query('days', { schema: z.coerce.number().int().positive().max(3650).optional() })
    days: number | undefined,
  ) {
    const from = new Date(Date.now() - (days ?? DEFAULT_DAYS) * 24 * 60 * 60 * 1000)
    const points = await this.prices.history(instrumentId, from)
    // Наружу — строки: цена остаётся деньгами и на графике.
    return points.map((point) => ({
      price: point.price.toString(),
      quotedAt: point.quotedAt.toISOString(),
    }))
  }
}
