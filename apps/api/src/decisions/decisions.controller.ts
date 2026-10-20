import { Body, Controller, Get, Param, Post } from '@nestjs/common'
import { UseGuards } from '@nestjs/common'
import { AuthGuard } from '@nestjs/passport'
import { ApiBearerAuth, ApiBody, ApiOperation } from '@nestjs/swagger'
import { z } from 'zod'
import { CurrentUser } from '../auth/current-user.decorator.ts'
import type { AuthenticatedUser } from '../auth/current-user.decorator.ts'
import { DecisionsService } from './decisions.service.ts'
import { createDecisionOpenApiSchema, createDecisionSchema, reviseDecisionSchema } from './dto.ts'
import type { CreateDecision, ReviseDecision } from './dto.ts'

// То же осознанное приведение, что в auth.controller.ts: Zod отдаёт JSON Schema,
// а @nestjs/swagger ждёт свой SchemaObject.
type ApiBodySchema = Extract<Parameters<typeof ApiBody>[0], { schema: unknown }>['schema']

@Controller('decisions')
@UseGuards(AuthGuard('jwt'))
@ApiBearerAuth()
export class DecisionsController {
  constructor(private readonly decisions: DecisionsService) {}

  @Get()
  @ApiOperation({ summary: 'Решения пользователя вместе с историей ревизий' })
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.decisions.list(user.userId)
  }

  @Post()
  @ApiOperation({ summary: 'Записать решение. Ядро неизменяемо — правка создаёт ревизию' })
  @ApiBody({ schema: createDecisionOpenApiSchema as ApiBodySchema })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body({ schema: createDecisionSchema }) body: CreateDecision,
  ) {
    return this.decisions.create(user.userId, body)
  }

  @Post(':id/revisions')
  @ApiOperation({ summary: 'Ревизия: полный снимок новых значений, исходное решение цело' })
  revise(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', { schema: z.uuid() }) id: string,
    @Body({ schema: reviseDecisionSchema }) body: ReviseDecision,
  ) {
    return this.decisions.revise(user.userId, id, body)
  }
}
