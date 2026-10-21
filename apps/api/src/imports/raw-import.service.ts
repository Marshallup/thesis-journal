import { createHash } from 'node:crypto'
import { Injectable } from '@nestjs/common'
import { PrismaService } from '../db/prisma.service.ts'

export type UploadResult = { importId: string; status: 'pending' | 'duplicate' }

// Источник берётся от счёта: отчёт, залитый в счёт Сбера, — отчёт Сбера.
// У ручного счёта брокера нет, поэтому остаётся обобщённый csv.
function sourceOf(provider: string): string {
  return provider === 'manual' ? 'csv' : provider
}

@Injectable()
export class RawImportService {
  constructor(private readonly prisma: PrismaService) {}

  // Хеш от содержимого, а не от имени: тот же отчёт под другим именем остаётся
  // тем же отчётом, а переименованный файл не должен создавать второй импорт.
  upload(
    userId: string,
    accountId: string,
    payload: Buffer,
    _filename: string,
  ): Promise<UploadResult> {
    const fileHash = createHash('sha256').update(payload).digest('hex')

    return this.prisma.withUser(userId, async (tx) => {
      // Явный фильтр по userId, RLS под ним — и это же проверка владения счётом.
      const account = await tx.account.findFirstOrThrow({ where: { id: accountId, userId } })

      // ON CONFLICT DO NOTHING RETURNING: «сначала select, потом insert» здесь
      // даёт гонку — между проверкой и вставкой влезет параллельная заливка.
      const inserted = await tx.$queryRaw<{ id: string }[]>`
        insert into raw_imports (account_id, source, file_hash, payload, status)
        values (
          ${accountId}::uuid, ${sourceOf(account.provider)}, ${fileHash},
          ${payload}, 'pending'
        )
        on conflict (account_id, file_hash) do nothing
        returning id
      `

      const created = inserted[0]
      if (created) return { importId: created.id, status: 'pending' }

      // Пусто — значит строку вставил кто-то другой: читаем её, а не падаем.
      const existing = await tx.rawImport.findUniqueOrThrow({
        where: { raw_import_idempotency: { accountId, fileHash } },
      })
      return { importId: existing.id, status: 'duplicate' }
    })
  }
}
