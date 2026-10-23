import { Body, Controller, HttpCode, Param, Post, UseGuards } from '@nestjs/common'
import { AuthGuard } from '@nestjs/passport'
import { ApiBearerAuth, ApiOperation } from '@nestjs/swagger'
import { z } from 'zod'
import { CurrentUser } from '../auth/current-user.decorator.ts'
import type { AuthenticatedUser } from '../auth/current-user.decorator.ts'
import { KeysService } from './keys.service.ts'
import type { SavedKey } from './keys.service.ts'

// Границы длины — не придирка: ключ Bybit короче сорока знаков не бывает, а
// поле без потолка превращается в способ положить в базу мегабайт.
const saveKeySchema = z.object({
  exchange: z.literal('bybit'),
  apiKey: z.string().min(8).max(128),
  apiSecret: z.string().min(8).max(256),
})

@Controller('accounts/:accountId/keys')
@UseGuards(AuthGuard('jwt'))
@ApiBearerAuth()
export class KeysController {
  constructor(private readonly keys: KeysService) {}

  @Post()
  // 202, а не 201: ключ станет рабочим, когда его запишет воркер. Притворяться,
  // что ответ окончательный, нельзя — экран должен это показывать.
  @HttpCode(202)
  @ApiOperation({ summary: 'Сохранить ключ биржи. Секрет наружу не возвращается никогда' })
  save(
    @CurrentUser() user: AuthenticatedUser,
    @Param('accountId', { schema: z.uuid() }) accountId: string,
    @Body({ schema: saveKeySchema }) body: z.infer<typeof saveKeySchema>,
  ): Promise<SavedKey> {
    return this.keys.save(user.userId, accountId, body)
  }
}
