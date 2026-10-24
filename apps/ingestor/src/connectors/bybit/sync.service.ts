import { createHash, randomUUID } from 'node:crypto'
import { Injectable, Logger } from '@nestjs/common'
import type { OnApplicationBootstrap } from '@nestjs/common'
import { ACCOUNT_SYNC_QUEUE, IMPORT_PARSED_TOPIC } from '@thesis/contracts'
import type { AccountSync, ImportParsed, RawOperation } from '@thesis/contracts'
import { BybitClient, isPermanent } from './client.ts'
import { mapExecution, splitWindows } from './mapper.ts'
import type { Execution } from './mapper.ts'
import { KeyVault } from '../../keys/vault.ts'
import { OutboxRepository } from '../../outbox/outbox.repository.ts'
import { PrismaService } from '../../db/prisma.service.ts'
import { ExternalCall } from '../../outbound/external-call.ts'
import { PermanentFailure, RabbitConsumer } from '../../rabbit/rabbit.consumer.ts'

// Поток, а не «биржа»: у одной биржи их несколько, и движения денег приедут
// своим — со своим курсором.
const STREAM = 'bybit:executions:spot'

// Глубина истории исполнений у Bybit — меньше двух лет, и граница строгая:
// запрос ровно на два года назад биржа отбивает кодом 10001 «Can't query order
// earlier than 2 years». Отсюда сутки запаса — их хватает и на високосный год,
// и на расхождение часов.
const DEPTH_MS = (2 * 365 - 1) * 24 * 60 * 60 * 1000

// В том же списке биржа отдаёт списания фондирования и ликвидации. Сделка —
// только `Trade`: остальное в лоты не ложится и приедет движениями денег,
// когда для них будет свой поток.
const TRADE = 'Trade'

const SOURCE = 'bybit'

// Только спот. Производные — это позиции, шорты и фондирование, а лотовая
// модель дневника держит длинные позиции по FIFO; записать туда перпетуал
// значит соврать в обе стороны. Запись в docs/unknowns.md.
const CATEGORY = 'spot' as const

@Injectable()
export class BybitSyncService implements OnApplicationBootstrap {
  private readonly log = new Logger(BybitSyncService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxRepository,
    private readonly vault: KeyVault,
    private readonly calls: ExternalCall,
    private readonly rabbit: RabbitConsumer,
  ) {}

  onApplicationBootstrap(): void {
    this.rabbit.on(ACCOUNT_SYNC_QUEUE, async (payload) => {
      await this.run(payload as AccountSync)
    })
  }

  async run(command: AccountSync): Promise<{ operations: number; windows: number }> {
    try {
      return await this.sync(command)
    } catch (error) {
      if (!isPermanent(error)) throw error

      // Отказ, который не исправится повтором: про него надо рассказать на
      // экран, а не молча уехать в отстойник. Экран смотрит на импорты —
      // значит и отказ приезжает импортом, тем же путём, что успех.
      await this.reportFailure(command, String(error))
      throw new PermanentFailure(String(error))
    }
  }

  private async sync(command: AccountSync): Promise<{ operations: number; windows: number }> {
    const { apiKeyPublic, secret } = await this.vault.secretFor(command.accountId, command.exchange)
    const client = new BybitClient({ apiKey: apiKeyPublic, secret }, this.calls)

    const cursor = await this.prisma.syncCursor.findUnique({
      where: { sync_cursor_per_stream: { accountId: command.accountId, stream: STREAM } },
    })
    const from = new Date(command.from ?? cursor?.syncedUntil ?? Date.now() - DEPTH_MS)
    const windows = splitWindows(from, new Date())

    let operations = 0
    for (const window of windows) {
      const rows = await this.fetchWindow(client, window)
      const trades = rows.filter((row) => row.execType === TRADE).map(mapExecution)
      if (trades.length > 0) await this.publish(command, trades)
      operations += trades.length

      // Курсор двигается по окнам, а не по всей синхронизации: обрыв на
      // середине двух лет не заставляет перечитывать два года.
      await this.remember(command.accountId, window.to)
    }

    this.log.log(
      `синхронизация ${command.exchange} счёта ${command.accountId}: ` +
        `${operations} исполнений за ${windows.length} окон`,
    )
    return { operations, windows: windows.length }
  }

  private async fetchWindow(
    client: BybitClient,
    window: { from: Date; to: Date },
  ): Promise<Execution[]> {
    const rows: Execution[] = []
    // Биржа отдаёт пустой курсор, когда выбрано всё. Повторный курсор —
    // признак неисправности на той стороне, и крутиться по нему вечно хуже,
    // чем отказать.
    const seen = new Set<string>()
    let cursor: string | undefined

    for (;;) {
      const page = await client.executions({
        category: CATEGORY,
        ...window,
        ...(cursor ? { cursor } : {}),
      })
      rows.push(...page.list)

      const next = page.nextPageCursor
      if (!next) return rows
      if (seen.has(next)) throw new Error(`Bybit вернул тот же курсор дважды: ${next}`)
      seen.add(next)
      cursor = next
    }
  }

  // Одно событие на окно, а не на всю синхронизацию: первая синхронизация за
  // два года — это сотня окон, и единственное событие на них не влезло бы в
  // сообщение Kafka.
  private async publish(command: AccountSync, operations: RawOperation[]): Promise<void> {
    // Хеш от идентификаторов исполнений, отсортированных: он не зависит от
    // порядка страниц, и то же окно второй раз даёт тот же хеш. По нему api
    // узнаёт, что нового нет.
    const fileHash = createHash('sha256')
      .update(
        operations
          .map((operation) => operation.externalId)
          .toSorted()
          .join('\n'),
      )
      .digest('hex')

    const event: ImportParsed = {
      importId: randomUUID(),
      accountId: command.accountId,
      userId: command.userId,
      source: SOURCE,
      fileHash,
      operations,
    }

    await this.prisma.$transaction((tx) =>
      this.outbox.enqueue(tx, [
        { topic: IMPORT_PARSED_TOPIC, key: command.accountId, payload: event },
      ]),
    )
  }

  // Отказ синхронизации виден там же, где её результат: строка импорта со
  // статусом failed и причиной. Хеш свой у каждой попытки — иначе второй отказ
  // отбился бы как «ту же выборку уже видели».
  private async reportFailure(command: AccountSync, reason: string): Promise<void> {
    const event: ImportParsed = {
      importId: randomUUID(),
      accountId: command.accountId,
      userId: command.userId,
      source: SOURCE,
      fileHash: createHash('sha256').update(`отказ:${randomUUID()}`).digest('hex'),
      operations: [],
      error: reason,
    }

    await this.prisma.$transaction((tx) =>
      this.outbox.enqueue(tx, [
        { topic: IMPORT_PARSED_TOPIC, key: command.accountId, payload: event },
      ]),
    )
  }

  private async remember(accountId: string, syncedUntil: Date): Promise<void> {
    await this.prisma.syncCursor.upsert({
      where: { sync_cursor_per_stream: { accountId, stream: STREAM } },
      create: { accountId, stream: STREAM, syncedUntil },
      update: { syncedUntil },
    })
  }
}
