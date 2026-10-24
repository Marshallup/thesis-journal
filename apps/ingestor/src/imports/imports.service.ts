import { Injectable, Logger } from '@nestjs/common'
import type { OnApplicationBootstrap } from '@nestjs/common'
import { IMPORT_PARSE_QUEUE, IMPORT_PARSED_TOPIC } from '@thesis/contracts'
import type { ImportParse, ImportParsed, RawOperation } from '@thesis/contracts'
import { PrismaService } from '../db/prisma.service.ts'
import { OutboxRepository } from '../outbox/outbox.repository.ts'
import { PermanentFailure, RabbitConsumer } from '../rabbit/rabbit.consumer.ts'
import { parseSberXlsx } from './sber-xlsx.ts'

// Разбор сырья по источнику. У отчёта это XLSX, у синхронизации — уже
// разобранные операции: коннектор сложил их байтами в то же место, и
// «разобрать заново» означает перечитать их, а не идти к бирже второй раз.
const PARSERS = new Map<string, (payload: Buffer) => Promise<RawOperation[]>>([
  ['sber', parseSberXlsx],
  ['bybit', readOperations],
])

// Своё сырьё, а не чужой ввод, но разбирать его всё равно надо проверяя: битый
// JSON здесь означает, что запись повреждена, и повтор этого не исправит.
function readOperations(payload: Buffer): Promise<RawOperation[]> {
  let parsed: unknown
  try {
    parsed = JSON.parse(payload.toString('utf8'))
  } catch (error) {
    throw new PermanentFailure(`сырьё синхронизации не читается: ${String(error)}`)
  }

  if (!Array.isArray(parsed)) throw new PermanentFailure('сырьё синхронизации — не список операций')
  return Promise.resolve(parsed as RawOperation[])
}

@Injectable()
export class ImportsService implements OnApplicationBootstrap {
  private readonly log = new Logger(ImportsService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxRepository,
    private readonly rabbit: RabbitConsumer,
  ) {}

  onApplicationBootstrap(): void {
    this.rabbit.on(IMPORT_PARSE_QUEUE, (payload) => this.parse(payload as ImportParse))
  }

  // Разбор отчёта: сырьё на место, операции — событием. Сети здесь нет, и
  // любая неудача разбора — отказ навсегда: тот же файл не переживёт второй
  // попытки иначе, чем первой.
  async parse(command: ImportParse): Promise<void> {
    const payload = await this.store(command)

    if (!PARSERS.has(command.source)) {
      const reason = `источник «${command.source}» пока не разбирается`
      await this.reportFailure(command, reason)
      throw new PermanentFailure(reason)
    }

    try {
      const operations = await PARSERS.get(command.source)!(payload)
      await this.publish({ ...this.envelope(command), operations })
      this.log.log(`импорт ${command.importId}: операций ${operations.length}`)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      await this.reportFailure(command, reason)
      throw new PermanentFailure(reason)
    }
  }

  // Байты приезжают в команде при первой отправке и отсутствуют при повторном
  // разборе: сырьё уже лежит здесь, и гонять файл второй раз незачем.
  private async store(command: ImportParse): Promise<Buffer> {
    if (command.payloadBase64) {
      const payload = Buffer.from(command.payloadBase64, 'base64')
      // upsert, а не create: повторная команда с байтами не должна ни падать,
      // ни плодить копии файла.
      await this.prisma.rawImport.upsert({
        where: { importId: command.importId },
        create: {
          importId: command.importId,
          source: command.source,
          fileHash: command.fileHash,
          payload,
        },
        update: {},
      })
      return payload
    }

    const stored = await this.prisma.rawImport.findUnique({
      where: { importId: command.importId },
      select: { payload: true },
    })
    if (!stored) throw new PermanentFailure(`сырья импорта ${command.importId} нет`)
    return Buffer.from(stored.payload)
  }

  private envelope(command: ImportParse): Omit<ImportParsed, 'operations'> {
    return {
      importId: command.importId,
      accountId: command.accountId,
      userId: command.userId,
      source: command.source,
    }
  }

  private publish(event: ImportParsed): Promise<unknown> {
    // Через outbox и в транзакции: событие о разборе — такой же факт, как
    // цена, и теряться оно не должно.
    return this.prisma.$transaction((tx) =>
      this.outbox.enqueue(tx, [
        // Ключ — импорт: события одного отчёта идут строго по порядку.
        { topic: IMPORT_PARSED_TOPIC, key: event.importId, payload: event },
      ]),
    )
  }

  // Отказ — тоже факт, и про него должен узнать тот, кто показывает статус.
  // Иначе экран вечно пишет «разбираем».
  private reportFailure(command: ImportParse, error: string): Promise<unknown> {
    return this.publish({ ...this.envelope(command), operations: [], error })
  }
}
