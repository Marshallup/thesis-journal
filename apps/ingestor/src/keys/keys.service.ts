import { readFileSync } from 'node:fs'
import { Injectable, Logger } from '@nestjs/common'
import type { OnApplicationBootstrap } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { EXCHANGE_KEY_SAVE_QUEUE } from '@thesis/contracts'
import { parseMasterKey, unseal } from '@thesis/contracts/crypto'
import type { ExchangeKeySave } from '@thesis/contracts'
import { PrismaService } from '../db/prisma.service.ts'
import { PermanentFailure, RabbitConsumer } from '../rabbit/rabbit.consumer.ts'
import type { Env } from '../config/env.ts'

@Injectable()
export class KeysService implements OnApplicationBootstrap {
  private readonly log = new Logger(KeysService.name)
  private masterKey: Buffer | null = null

  constructor(
    private readonly prisma: PrismaService,
    private readonly rabbit: RabbitConsumer,
    private readonly config: ConfigService<Env, true>,
  ) {}

  onApplicationBootstrap(): void {
    this.rabbit.on(EXCHANGE_KEY_SAVE_QUEUE, (payload) => this.save(payload as ExchangeKeySave))
  }

  async save(command: ExchangeKeySave): Promise<void> {
    const box = {
      ciphertext: Buffer.from(command.ciphertextBase64, 'base64'),
      nonce: Buffer.from(command.nonceBase64, 'base64'),
      tag: Buffer.from(command.tagBase64, 'base64'),
    }

    // Расшифровка на входе — не лишняя работа, а проверка: разъехавшиеся
    // мастер-ключи api и воркера видно здесь, а не при первой синхронизации с
    // биржей. Открытый текст немедленно выбрасывается, в базу он не попадает.
    try {
      unseal(box, this.master())
    } catch (error) {
      // Повторять нечего: тот же шифротекст не расшифруется и со второй
      // попытки. В отстойник, с причиной.
      throw new PermanentFailure(`ключ не расшифровывается: ${String(error)}`)
    }

    const key = { accountId: command.accountId, exchange: command.exchange }
    await this.prisma.exchangeKey.upsert({
      where: { exchange_key_per_account: key },
      create: { ...key, apiKeyPublic: command.apiKeyPublic, ...box },
      update: { apiKeyPublic: command.apiKeyPublic, ...box },
    })

    this.log.log(`ключ ${command.exchange} счёта ${command.accountId} сохранён`)
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
