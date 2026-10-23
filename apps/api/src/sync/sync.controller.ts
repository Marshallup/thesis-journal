import { Body, Controller, HttpCode, Param, Post, UseGuards } from '@nestjs/common'
import { AuthGuard } from '@nestjs/passport'
import { ApiBearerAuth, ApiOperation } from '@nestjs/swagger'
import { z } from 'zod'
import { CurrentUser } from '../auth/current-user.decorator.ts'
import type { AuthenticatedUser } from '../auth/current-user.decorator.ts'
import { SyncService } from './sync.service.ts'
import type { SyncStarted } from './sync.service.ts'

// Дата начала необязательна: без неё воркер продолжит с того места, где
// остановился в прошлый раз.
const startSyncSchema = z.object({ from: z.iso.datetime().optional() })

@Controller('accounts/:accountId/sync')
@UseGuards(AuthGuard('jwt'))
@ApiBearerAuth()
export class SyncController {
  constructor(private readonly sync: SyncService) {}

  @Post()
  // 202: сделки приедут событиями, и к моменту ответа их ещё нет.
  @HttpCode(202)
  @ApiOperation({ summary: 'Запросить синхронизацию сделок с биржей' })
  start(
    @CurrentUser() user: AuthenticatedUser,
    @Param('accountId', { schema: z.uuid() }) accountId: string,
    @Body({ schema: startSyncSchema }) body: z.infer<typeof startSyncSchema>,
  ): Promise<SyncStarted> {
    return this.sync.start(user.userId, accountId, body.from)
  }
}
