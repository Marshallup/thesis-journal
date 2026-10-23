import { readFileSync } from 'node:fs'
import { Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { parseMasterKey, unseal } from '@thesis/contracts/crypto'
import type { SealedBox } from '@thesis/contracts/crypto'
import { PermanentFailure } from '../rabbit/rabbit.consumer.ts'
import { PrismaService } from '../db/prisma.service.ts'
import type { Env } from '../config/env.ts'

// Единственное место, где из шифротекста получается секрет. Отдельный сервис
// потому, что пользователей двое: обработчик команды «сохрани ключ» и
// синхронизация. Два мастер-ключа в одном процессе — это два места, где можно
// забыть про файл.
@Injectable()
export class KeyVault {
  private masterKey: Buffer | null = null

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  // Коробка, приехавшая в команде: расшифровка здесь ещё и проверка
  // целостности — разъехавшиеся мастер-ключи api и воркера видно сразу.
  open(box: SealedBox): string {
    try {
      return unseal(box, this.master())
    } catch (error) {
      // Повторять нечего: тот же шифротекст не расшифруется и со второй
      // попытки. В отстойник, с причиной.
      throw new PermanentFailure(`ключ не расшифровывается: ${String(error)}`)
    }
  }

  // Ключ сохранённого счёта. Отсутствие — отказ навсегда: ключ появится не от
  // повторной попытки, а когда его сохранят.
  async secretFor(
    accountId: string,
    exchange: string,
  ): Promise<{ apiKeyPublic: string; secret: string }> {
    const key = await this.prisma.exchangeKey.findUnique({
      where: { exchange_key_per_account: { accountId, exchange } },
    })
    if (!key) throw new PermanentFailure(`ключ ${exchange} счёта ${accountId} не сохранён`)

    return { apiKeyPublic: key.apiKeyPublic, secret: this.open(key) }
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
