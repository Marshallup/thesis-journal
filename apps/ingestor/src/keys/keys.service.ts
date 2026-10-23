import { readFileSync } from 'node:fs'
import { Injectable, Logger } from '@nestjs/common'
import type { OnApplicationBootstrap } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { EXCHANGE_KEY_SAVE_QUEUE, KEYS_TOPIC } from '@thesis/contracts'
import { parseMasterKey, unseal } from '@thesis/contracts/crypto'
import type { ExchangeKeyChecked, ExchangeKeySave } from '@thesis/contracts'
import { BybitClient } from '../connectors/bybit/client.ts'
import { ExternalCall } from '../outbound/external-call.ts'
import { verdict } from '../connectors/bybit/api-key.ts'
import { OutboxRepository } from '../outbox/outbox.repository.ts'
import { PrismaService } from '../db/prisma.service.ts'
import { PermanentFailure, RabbitConsumer } from '../rabbit/rabbit.consumer.ts'
import type { Env } from '../config/env.ts'

@Injectable()
export class KeysService implements OnApplicationBootstrap {
  private readonly log = new Logger(KeysService.name)
  private masterKey: Buffer | null = null

  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxRepository,
    private readonly calls: ExternalCall,
    private readonly rabbit: RabbitConsumer,
    private readonly config: ConfigService<Env, true>,
  ) {}

  onApplicationBootstrap(): void {
    this.rabbit.on(EXCHANGE_KEY_SAVE_QUEUE, (payload) => this.save(payload as ExchangeKeySave))
  }

  async save(command: ExchangeKeySave): Promise<void> {
    const secret = this.open(command)

    // Права спрашиваем **до** записи: ключ, которому мы откажем, не должен
    // попасть на диск вовсе. Иначе отклонённый секрет полежал бы в базе
    // столько, сколько заняла проверка, — и остался бы в бэкапе.
    const client = new BybitClient({ apiKey: command.apiKeyPublic, secret }, this.calls)
    const info = await client.queryApiKey()
    const check = verdict(info)

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

  private box(command: ExchangeKeySave) {
    return {
      ciphertext: Buffer.from(command.ciphertextBase64, 'base64'),
      nonce: Buffer.from(command.nonceBase64, 'base64'),
      tag: Buffer.from(command.tagBase64, 'base64'),
    }
  }

  // Расшифровка нужна дважды: без секрета не подписать запрос к бирже, и она же
  // проверка целостности — разъехавшиеся мастер-ключи api и воркера видно
  // здесь, а не при первой синхронизации.
  private open(command: ExchangeKeySave): string {
    try {
      return unseal(this.box(command), this.master())
    } catch (error) {
      // Повторять нечего: тот же шифротекст не расшифруется и со второй
      // попытки. В отстойник, с причиной.
      throw new PermanentFailure(`ключ не расшифровывается: ${String(error)}`)
    }
  }

  // Читается один раз и лениво: воркер без биржевых ключей работает как
  // раньше, а при первой же команде отсутствие файла — отказ навсегда, а не
  // три попытки вслепую.
  private master(): Buffer {
    if (this.masterKey) return this.masterKey

    const path = this.config.get('MASTER_KEY_FILE', { infer: true })
    if (!path) throw new PermanentFailure('пришёл ключ биржи, а MASTER_KEY_FILE у воркера не задан')

    this.masterKey = parseMasterKey(readFileSync(path, 'utf8'))
    return this.masterKey
  }
}
