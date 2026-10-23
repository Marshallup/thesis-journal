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

// Состояние ключа для экрана. Секрета здесь нет и быть не может: в `api_keys`
// его тоже нет — только маска.
export type KeyState = {
  exchange: string
  mask: string
  status: string
  error: string | null
  verifiedAt: string | null
}

// Флаг едет вместе с ключом: экран должен объяснять, почему формы нет, а не
// показывать её и получать 403 на отправке.
export type KeysView = { enabled: boolean; key: KeyState | null }
export type SavedKey = { id: string; mask: string; status: 'unverified' }

// Первые четыре знака и последние четыре. Этого хватает, чтобы узнать свой
// ключ в списке, и не хватает, чтобы им воспользоваться.
function mask(apiKey: string): string {
  return apiKey.length <= 8 ? '…' : `${apiKey.slice(0, 4)}…${apiKey.slice(-4)}`
}

@Injectable()
export class KeysService {
  private readonly log = new Logger(KeysService.name)
  private readonly masterKey: Buffer | null

  constructor(
    private readonly prisma: PrismaService,
    private readonly rabbit: RabbitPublisher,
    config: ConfigService<Env, true>,
  ) {
    // Фича выключена — мастер-ключ не нужен. Включена — читается здесь, на
    // старте: процесс должен падать сейчас, а не на первом ключе пользователя.
    if (!config.get('EXCHANGE_KEYS_ENABLED', { infer: true })) {
      this.masterKey = null
      return
    }

    const path = config.get('MASTER_KEY_FILE', { infer: true })
    if (!path) {
      throw new Error('EXCHANGE_KEYS_ENABLED включён, а MASTER_KEY_FILE нет: шифровать нечем')
    }
    this.masterKey = parseMasterKey(readFileSync(path, 'utf8'))
  }

  async view(userId: string, accountId: string): Promise<KeysView> {
    const key = await this.prisma.withUser(userId, async (tx) => {
      // Явный фильтр по userId, RLS под ним — и это же проверка владения счётом.
      await tx.account.findFirstOrThrow({ where: { id: accountId, userId } })
      return tx.apiKey.findFirst({ where: { accountId } })
    })

    return {
      enabled: this.masterKey !== null,
      key: key
        ? {
            exchange: key.exchange,
            mask: key.keyMask,
            status: key.status,
            error: key.error,
            verifiedAt: key.verifiedAt?.toISOString() ?? null,
          }
        : null,
    }
  }

  // Ключ принимается, но пока не используется: права проверит коннектор при
  // первом подключении, и до тех пор статус — unverified.
  async save(userId: string, accountId: string, input: SaveKey): Promise<SavedKey> {
    const masterKey = this.enabled()

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
      userId,
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

  // Фича-флаг на весь эндпоинт: выключено — отказ до записи и до отправки
  // команды. Кто именно пришёл, флага не касается: владение счётом проверяет
  // сам запрос, а чужие строки закрывает RLS.
  private enabled(): Buffer {
    const masterKey = this.masterKey
    if (!masterKey) {
      throw new ForbiddenException(
        'приём биржевых ключей выключен: сейчас только ручной импорт отчётов',
      )
    }
    return masterKey
  }
}
