import { createHash } from 'node:crypto'
import { Injectable, Logger } from '@nestjs/common'
import { IMPORT_PARSE_QUEUE } from '@thesis/contracts'
import type { ImportParse } from '@thesis/contracts'
import { PrismaService } from '../db/prisma.service.ts'
import { RabbitPublisher } from '../rabbit/rabbit.publisher.ts'

export type UploadResult = { importId: string; status: 'uploaded' | 'duplicate' }
export type ImportResultSummary = { created: number; skipped: number; deferred: number }

export type ImportStatus = {
  id: string
  status: string
  error: string | null
  result: ImportResultSummary | null
  createdAt: string
}

// Строка списка: к статусу добавлен источник — на экране биржи и отчёта
// соседствуют импорты из файла и из синхронизации, и различать их надо.
export type ImportRow = ImportStatus & { source: string }

// Двадцать строк: синхронизация за два года создаёт импорт на каждое окно с
// сделками, и показывать их все на экране незачем — нужны последние.
const LIST_LIMIT = 20

// Источник берётся от счёта: отчёт, залитый в счёт Сбера, — отчёт Сбера.
// У ручного счёта брокера нет, поэтому остаётся обобщённый csv.
//
// У биржи источников два, и различать их обязательно: `bybit` — операции,
// приехавшие синхронизацией по API, `bybit-statement` — архив выгрузки из
// кабинета. У них разные разборщики, разные ключи идемпотентности и разная
// глубина, а имя источника выбирает разборщик у воркера.
function sourceOf(provider: string): string {
  if (provider === 'manual') return 'csv'
  return provider === 'bybit' ? 'bybit-statement' : provider
}

@Injectable()
export class ImportsService {
  private readonly log = new Logger(ImportsService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly rabbit: RabbitPublisher,
  ) {}

  // Хеш от содержимого, а не от имени: тот же отчёт под другим именем остаётся
  // тем же отчётом, а переименованный файл не должен создавать второй импорт.
  async upload(
    userId: string,
    accountId: string,
    payload: Buffer,
    _filename: string,
  ): Promise<UploadResult> {
    const fileHash = createHash('sha256').update(payload).digest('hex')

    const result = await this.prisma.withUser(userId, async (tx) => {
      // Явный фильтр по userId, RLS под ним — и это же проверка владения счётом.
      const account = await tx.account.findFirstOrThrow({ where: { id: accountId, userId } })
      const source = sourceOf(account.provider)

      // ON CONFLICT DO NOTHING RETURNING: «сначала select, потом insert» здесь
      // даёт гонку — между проверкой и вставкой влезет параллельная заливка.
      const inserted = await tx.$queryRaw<{ id: string }[]>`
        insert into imports (account_id, source, file_hash, status)
        values (${accountId}::uuid, ${source}, ${fileHash}, 'uploaded')
        on conflict (account_id, file_hash) do nothing
        returning id
      `

      const created = inserted[0]
      if (created) return { importId: created.id, source, fresh: true }

      // Пусто — значит строку вставил кто-то другой: читаем её, а не падаем.
      const existing = await tx.import.findUniqueOrThrow({
        where: { import_idempotency: { accountId, fileHash } },
      })
      return { importId: existing.id, source, fresh: false }
    })

    if (!result.fresh) return { importId: result.importId, status: 'duplicate' }

    // Граница по дате для выгрузки из кабинета: всё, что новее самой ранней
    // сделки, приехавшей по API, уже есть в журнале со своим `execId`. Считает
    // её api — только он видит свои сделки, у воркера прав на них нет.
    const cutoff =
      result.source === 'bybit-statement' ? await this.apiCutoff(userId, accountId) : null

    // Байты уезжают в команде. Решено 22.10: отчёт Сбера — сотни килобайт,
    // брокер их вынесет, а объектное хранилище ради одного файла в неделю —
    // третий сервис в compose. Потолок держит контроллер; при первом отчёте на
    // десятки мегабайт понадобится хранилище, запись в docs/unknowns.md.
    const command: ImportParse = {
      importId: result.importId,
      accountId,
      userId,
      source: result.source,
      fileHash,
      payloadBase64: payload.toString('base64'),
      ...(cutoff ? { cutoff: cutoff.toISOString() } : {}),
    }
    this.rabbit.send(IMPORT_PARSE_QUEUE, command)
    this.log.log(`импорт ${result.importId}: команда на разбор отправлена`)

    return { importId: result.importId, status: 'uploaded' }
  }

  // Самая ранняя сделка счёта, пришедшая синхронизацией. Провайдер здесь
  // именно `bybit`, а не счётный: сделки из выгрузки помечены своим
  // провайдером, и считать границу по ним значило бы сдвигать её с каждым
  // импортом.
  private async apiCutoff(userId: string, accountId: string): Promise<Date | null> {
    const [earliest] = await this.prisma.withUser(
      userId,
      (tx) =>
        tx.$queryRaw<{ executedAt: Date }[]>`
        select min(executed_at) as "executedAt"
          from trades
         where account_id = ${accountId}::uuid
           and provider = 'bybit'
           and external_id is not null
      `,
    )
    return earliest?.executedAt ?? null
  }

  // Повторный разбор: байты уже у воркера, гонять файл второй раз незачем.
  // Нужен, когда разбор отказал по исправимой причине — например, добавили
  // недостающую покупку руками и хотят применить отчёт заново.
  async reparse(userId: string, importId: string): Promise<ImportStatus> {
    const row = await this.prisma.withUser(userId, async (tx) => {
      const found = await tx.import.findUniqueOrThrow({ where: { id: importId } })
      await tx.import.update({
        where: { id: importId },
        data: { status: 'uploaded', error: null },
      })
      return found
    })

    this.rabbit.send(IMPORT_PARSE_QUEUE, {
      importId,
      accountId: row.accountId,
      userId,
      source: row.source,
      fileHash: row.fileHash,
    } satisfies ImportParse)

    return {
      id: row.id,
      status: 'uploaded',
      error: null,
      result: null,
      createdAt: row.createdAt.toISOString(),
    }
  }

  // Статус для экрана: разбор асинхронный, и человеку надо видеть, на чём он.
  // Последние импорты счёта. Нужны экрану синхронизации: команда асинхронная,
  // и единственный способ узнать, чем она кончилась, — посмотреть импорты,
  // которые она создала.
  async recent(userId: string, accountId?: string): Promise<ImportRow[]> {
    const rows = await this.prisma.withUser(userId, (tx) =>
      tx.import.findMany({
        // RLS уже ограничивает выборку своими счетами; фильтр по счёту —
        // сужение внутри них, а не защита.
        where: accountId ? { accountId } : {},
        orderBy: { createdAt: 'desc' },
        take: LIST_LIMIT,
      }),
    )

    return rows.map((row) => ({
      id: row.id,
      source: row.source,
      status: row.status,
      error: row.error,
      result: (row.result as ImportResultSummary | null) ?? null,
      createdAt: row.createdAt.toISOString(),
    }))
  }

  async status(userId: string, importId: string): Promise<ImportStatus> {
    const row = await this.prisma.withUser(userId, (tx) =>
      tx.import.findUniqueOrThrow({ where: { id: importId } }),
    )
    return {
      id: row.id,
      status: row.status,
      error: row.error,
      result: (row.result as ImportResultSummary | null) ?? null,
      createdAt: row.createdAt.toISOString(),
    }
  }
}
