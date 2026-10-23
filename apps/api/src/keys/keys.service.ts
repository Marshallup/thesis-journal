import { readFileSync } from 'node:fs'
import { ForbiddenException, Injectable, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { EXCHANGE_KEY_SAVE_QUEUE } from '@thesis/contracts'
import { parseMasterKey, seal } from '@thesis/contracts/crypto'
import type { ExchangeKeySave } from '@thesis/contracts'
import { PrismaService } from '../db/prisma.service.ts'
import { RabbitPublisher } from '../rabbit/rabbit.publisher.ts'
import type { Env } from '../config/env.ts'

export type SaveKey = { exchange: 'bybit'; apiKey: string; apiSecret: string }
export type SavedKey = { id: string; mask: string; status: 'unverified' }

// Первые четыре знака и последние четыре. Этого хватает, чтобы узнать свой
// ключ в списке, и не хватает, чтобы им воспользоваться.
function mask(apiKey: string): string {
  return apiKey.length <= 8 ? '…' : `${apiKey.slice(0, 4)}…${apiKey.slice(-4)}`
}

@Injectable()
export class KeysService {
  private readonly log = new Logger(KeysService.name)
  private readonly allowlist: Set<string>
  private readonly masterKey: Buffer | null

  constructor(
    private readonly prisma: PrismaService,
    private readonly rabbit: RabbitPublisher,
    config: ConfigService<Env, true>,
  ) {
    this.allowlist = new Set(
      (config.get('EXCHANGE_KEYS_ALLOWLIST', { infer: true }) ?? '')
        .split(',')
        .map((email) => email.trim().toLowerCase())
        .filter(Boolean),
    )

    // Пустой allowlist — фича выключена, и мастер-ключ не нужен. Непустой —
    // ключ читается здесь, на старте: процесс должен падать сейчас, а не на
    // первом ключе пользователя.
    if (this.allowlist.size === 0) {
      this.masterKey = null
      return
    }

    const path = config.get('MASTER_KEY_FILE', { infer: true })
    if (!path) {
      throw new Error('EXCHANGE_KEYS_ALLOWLIST задан, а MASTER_KEY_FILE нет: шифровать нечем')
    }
    this.masterKey = parseMasterKey(readFileSync(path, 'utf8'))
  }

  // Ключ принимается, но пока не используется: права проверит коннектор при
  // первом подключении, и до тех пор статус — unverified.
  async save(userId: string, accountId: string, input: SaveKey): Promise<SavedKey> {
    const masterKey = await this.allowed(userId)

    const saved = await this.prisma.withUser(userId, async (tx) => {
      // Явный фильтр по userId, RLS под ним — и это же проверка владения счётом.
      await tx.account.findFirstOrThrow({ where: { id: accountId, userId } })

      // Второй ключ к тому же счёту — это замена первого. ON CONFLICT, а не
      // «сначала посмотреть, есть ли»: между проверкой и вставкой влезет
      // вторая отправка.
      const rows = await tx.$queryRaw<{ id: string }[]>`
        insert into api_keys (account_id, exchange, key_mask, status)
        values (${accountId}::uuid, ${input.exchange}, ${mask(input.apiKey)}, 'unverified')
        on conflict (account_id, exchange) do update
          set key_mask = excluded.key_mask,
              status = 'unverified',
              permissions = null,
              verified_at = null
        returning id
      `
      return rows[0]
    })

    if (!saved) throw new Error('ключ не записан: api_keys не вернул строку')

    // Секрет уезжает шифротекстом: сообщения брокера лежат на диске, а
    // мастер-ключ в брокер не попадает никогда.
    const box = seal(input.apiSecret, masterKey)
    const command: ExchangeKeySave = {
      accountId,
      exchange: input.exchange,
      apiKeyPublic: input.apiKey,
      ciphertextBase64: box.ciphertext.toString('base64'),
      nonceBase64: box.nonce.toString('base64'),
      tagBase64: box.tag.toString('base64'),
    }
    this.rabbit.send(EXCHANGE_KEY_SAVE_QUEUE, command)
    // В логе маска, а не ключ: правило проекта — секретов в логах не бывает.
    this.log.log(`ключ ${input.exchange} ${mask(input.apiKey)}: команда на сохранение отправлена`)

    return { id: saved.id, mask: mask(input.apiKey), status: 'unverified' }
  }

  // Фича-флаг: пока не пройден первый настоящий ключ, открывать ввод секретов
  // всем остальным незачем. Список — по почте: её человек может написать в
  // окружении, а свой идентификатор он не знает.
  private async allowed(userId: string): Promise<Buffer> {
    const masterKey = this.masterKey
    const refusal = 'приём биржевых ключей выключен: сейчас только ручной импорт отчётов'
    if (!masterKey) throw new ForbiddenException(refusal)

    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { email: true },
    })
    if (!this.allowlist.has(user.email.toLowerCase())) throw new ForbiddenException(refusal)

    return masterKey
  }
}
