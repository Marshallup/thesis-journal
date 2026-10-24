import { Injectable, Logger } from '@nestjs/common'
import type { OnApplicationBootstrap } from '@nestjs/common'
import { EXCHANGE_KEY_SAVE_QUEUE, KEYS_TOPIC } from '@thesis/contracts'
import type { ExchangeKeyChecked, ExchangeKeySave } from '@thesis/contracts'
import { BybitClient, isPermanent } from '../connectors/bybit/client.ts'
import { ExternalCall } from '../outbound/external-call.ts'
import { verdict } from '../connectors/bybit/api-key.ts'
import { OutboxRepository } from '../outbox/outbox.repository.ts'
import { PrismaService } from '../db/prisma.service.ts'
import { RabbitConsumer } from '../rabbit/rabbit.consumer.ts'
import { KeyVault } from './vault.ts'

@Injectable()
export class KeysService implements OnApplicationBootstrap {
  private readonly log = new Logger(KeysService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxRepository,
    private readonly vault: KeyVault,
    private readonly calls: ExternalCall,
    private readonly rabbit: RabbitConsumer,
  ) {}

  onApplicationBootstrap(): void {
    this.rabbit.on(EXCHANGE_KEY_SAVE_QUEUE, (payload) => this.save(payload as ExchangeKeySave))
  }

  async save(command: ExchangeKeySave): Promise<void> {
    const secret = this.vault.open(this.box(command))

    // Права спрашиваем **до** записи: ключ, которому мы откажем, не должен
    // попасть на диск вовсе. Иначе отклонённый секрет полежал бы в базе
    // столько, сколько заняла проверка, — и остался бы в бэкапе.
    const client = new BybitClient({ apiKey: command.apiKeyPublic, secret }, this.calls)
    const check = await this.check(client)

    const event: ExchangeKeyChecked = {
      accountId: command.accountId,
      userId: command.userId,
      exchange: command.exchange,
      status: check.ok ? 'active' : 'rejected',
      scopes: check.scopes,
      ...(check.ok ? {} : { reason: check.reason }),
      checkedAt: new Date().toISOString(),
    }

    // Запись ключа и событие о проверке — в одной транзакции: статус в api не
    // должен разойтись с тем, что лежит у воркера.
    await this.prisma.$transaction(async (tx) => {
      if (check.ok) {
        const key = { accountId: command.accountId, exchange: command.exchange }
        const box = this.box(command)
        await tx.exchangeKey.upsert({
          where: { exchange_key_per_account: key },
          create: { ...key, apiKeyPublic: command.apiKeyPublic, ...box },
          update: { apiKeyPublic: command.apiKeyPublic, ...box },
        })
      }
      await this.outbox.enqueue(tx, [{ topic: KEYS_TOPIC, key: command.accountId, payload: event }])
    })

    this.log.log(
      check.ok
        ? `ключ ${command.exchange} счёта ${command.accountId} сохранён`
        : `ключ ${command.exchange} счёта ${command.accountId} отклонён: ${check.reason}`,
    )
  }

  // Биржа может не принять ключ вовсе — опечатка, истёкший срок, белый список
  // адресов. Повторять это бессмысленно, а экран без ответа навсегда остался
  // бы на «ждёт проверки»: поэтому такой отказ становится вердиктом с причиной
  // от самой биржи.
  private async check(client: BybitClient): Promise<ReturnType<typeof verdict>> {
    try {
      return verdict(await client.queryApiKey())
    } catch (error) {
      if (!isPermanent(error)) throw error
      return { ok: false, scopes: [], reason: `биржа не приняла ключ: ${String(error)}` }
    }
  }

  private box(command: ExchangeKeySave) {
    return {
      ciphertext: Buffer.from(command.ciphertextBase64, 'base64'),
      nonce: Buffer.from(command.nonceBase64, 'base64'),
      tag: Buffer.from(command.tagBase64, 'base64'),
    }
  }
}
