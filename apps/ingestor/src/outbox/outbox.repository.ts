import { Injectable } from '@nestjs/common'
import type { Prisma } from '@thesis/db'
import { PrismaService } from '../db/prisma.service.ts'

export type OutboxDraft = { topic: string; key: string; payload: unknown }

export type PendingEvent = { id: string; topic: string; key: string; payload: unknown }

@Injectable()
export class OutboxRepository {
  constructor(private readonly prisma: PrismaService) {}

  // Транзакция приходит аргументом — в этом весь смысл outbox: событие
  // записывается вместе с данными, о которых оно говорит, или не записывается
  // вовсе. Свою транзакцию здесь открыть нельзя, иначе гарантия исчезает.
  enqueue(tx: Prisma.TransactionClient, drafts: OutboxDraft[]): Promise<unknown> {
    if (drafts.length === 0) return Promise.resolve(0)
    return tx.outboxEvent.createMany({
      data: drafts.map((draft) => ({
        topic: draft.topic,
        key: draft.key,
        payload: draft.payload as Prisma.InputJsonValue,
      })),
    })
  }

  // Порядок по id, а не по created_at: uuidv7 монотонен по времени, а два
  // события одной транзакции получают одинаковый created_at.
  pending(limit: number): Promise<PendingEvent[]> {
    return this.prisma.outboxEvent.findMany({
      where: { publishedAt: null },
      orderBy: { id: 'asc' },
      take: limit,
      select: { id: true, topic: true, key: true, payload: true },
    })
  }

  // Отметка после успешной отправки. Упасть между отправкой и отметкой можно,
  // и тогда событие уйдёт второй раз — потребитель обязан это выдержать.
  markPublished(ids: string[]): Promise<unknown> {
    return this.prisma.outboxEvent.updateMany({
      where: { id: { in: ids } },
      data: { publishedAt: new Date() },
    })
  }

  unpublishedCount(): Promise<number> {
    return this.prisma.outboxEvent.count({ where: { publishedAt: null } })
  }
}
