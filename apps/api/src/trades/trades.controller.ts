import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common'
import { AuthGuard } from '@nestjs/passport'
import { z } from 'zod'
import { ApiBearerAuth, ApiBody, ApiOperation } from '@nestjs/swagger'
import { CurrentUser } from '../auth/current-user.decorator.ts'
import type { AuthenticatedUser } from '../auth/current-user.decorator.ts'
import { applyTradeOpenApiSchema, applyTradeSchema } from './dto.ts'
import type { ApplyTrade } from './dto.ts'
import { TradesService } from './trades.service.ts'

// Zod отдаёт JSON Schema, а @nestjs/swagger ждёт свой SchemaObject — то же
// осознанное приведение, что в auth.controller.ts.
type ApiBodySchema = Extract<Parameters<typeof ApiBody>[0], { schema: unknown }>['schema']

@Controller('trades')
@UseGuards(AuthGuard('jwt'))
@ApiBearerAuth()
export class TradesController {
  constructor(private readonly trades: TradesService) {}

  @Get()
  @ApiOperation({ summary: 'Сделки пользователя, свежие первыми; linked=false — без решения' })
  list(
    @CurrentUser() user: AuthenticatedUser,
    // В query всё приходит строкой, поэтому «false» — это строка, а не boolean.
    @Query('linked', { schema: z.enum(['true', 'false']).optional() })
    linked: 'true' | 'false' | undefined,
  ) {
    return this.trades.list(user.userId, linked ? { linked: linked === 'true' } : {})
  }

  @Post()
  @ApiOperation({ summary: 'Ручная сделка: сделка, лоты и позиция в одной транзакции' })
  @ApiBody({ schema: applyTradeOpenApiSchema as ApiBodySchema })
  apply(
    @CurrentUser() user: AuthenticatedUser,
    @Body({ schema: applyTradeSchema }) body: ApplyTrade,
  ) {
    return this.trades.apply(user.userId, body)
  }
}
