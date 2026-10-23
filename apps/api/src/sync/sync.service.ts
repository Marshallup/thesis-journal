import { BadRequestException, Injectable, Logger } from '@nestjs/common'
import { ACCOUNT_SYNC_QUEUE } from '@thesis/contracts'
import type { AccountSync } from '@thesis/contracts'
import { PrismaService } from '../db/prisma.service.ts'
import { RabbitPublisher } from '../rabbit/rabbit.publisher.ts'

export type SyncStarted = { queued: true; exchange: string }

@Injectable()
export class SyncService {
  private readonly log = new Logger(SyncService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly rabbit: RabbitPublisher,
  ) {}

  // Синхронизация асинхронная: api только ставит команду. Ответ 202 — это
  // «принято», и экран должен следить за импортами, а не считать дело
  // сделанным.
  async start(userId: string, accountId: string, from?: string): Promise<SyncStarted> {
    const key = await this.prisma.withUser(userId, async (tx) => {
      // Явный фильтр по userId, RLS под ним — и это же проверка владения счётом.
      await tx.account.findFirstOrThrow({ where: { id: accountId, userId } })
      return tx.apiKey.findFirst({ where: { accountId } })
    })

    if (!key) throw new BadRequestException('у счёта нет биржевого ключа')
    // Ключ, права которого не проверены или отклонены, на биржу не идёт:
    // обещание про read-only держится тем, что непроверенным ключом не ходят.
    if (key.status !== 'active') {
      const reason = key.error ? ` — ${key.error}` : ''
      throw new BadRequestException(`ключ не проверен (${key.status})${reason}`)
    }

    const command: AccountSync = {
      accountId,
      userId,
      exchange: key.exchange as 'bybit',
      ...(from ? { from } : {}),
    }
    this.rabbit.send(ACCOUNT_SYNC_QUEUE, command)
    this.log.log(`счёт ${accountId}: команда на синхронизацию ${key.exchange} отправлена`)

    return { queued: true, exchange: key.exchange }
  }
}
