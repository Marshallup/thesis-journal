import { Injectable } from '@nestjs/common'
import { PrismaService } from '../db/prisma.service.ts'
import type { CreateDecision, ReviseDecision } from './dto.ts'

@Injectable()
export class DecisionsService {
  constructor(private readonly prisma: PrismaService) {}

  create(userId: string, dto: CreateDecision) {
    return this.prisma.withUser(userId, async (tx) => {
      // Явный фильтр по userId, RLS под ним — второй рубеж. Заодно проверка
      // владения счётом: чужой не найдётся.
      await tx.account.findFirstOrThrow({ where: { id: dto.accountId, userId } })
      // Поля выписаны явно: при exactOptionalPropertyTypes пропущенное поле и
      // пустое значение — разные вещи, и для базы это null, а не undefined.
      return tx.decision.create({
        data: {
          accountId: dto.accountId,
          instrumentId: dto.instrumentId,
          side: dto.side,
          thesis: dto.thesis,
          horizonDays: dto.horizonDays,
          conviction: dto.conviction,
          mood: dto.mood,
          invalidator: dto.invalidator ?? null,
          tags: dto.tags ?? [],
          freeText: dto.freeText ?? null,
        },
      })
    })
  }

  // Исходное решение не трогаем — его защищает триггер. Правка это новая строка
  // с полным снимком, и снимок берётся от действующего состояния: иначе правка
  // одного поля обнулила бы остальные.
  revise(userId: string, id: string, dto: ReviseDecision) {
    return this.prisma.withUser(userId, async (tx) => {
      const decision = await tx.decision.findUniqueOrThrow({ where: { id } })
      await tx.account.findFirstOrThrow({ where: { id: decision.accountId, userId } })

      const latest = await tx.decisionRevision.findFirst({
        where: { decisionId: id },
        orderBy: { createdAt: 'desc' },
      })
      const current = latest ?? decision

      return tx.decisionRevision.create({
        data: {
          accountId: decision.accountId,
          decisionId: id,
          thesis: dto.thesis ?? current.thesis,
          horizonDays: dto.horizonDays ?? current.horizonDays,
          conviction: dto.conviction ?? current.conviction,
          mood: dto.mood ?? current.mood,
          invalidator: dto.invalidator ?? current.invalidator,
          tags: dto.tags ?? current.tags,
          freeText: dto.freeText ?? current.freeText,
        },
      })
    })
  }

  // Действующее состояние — последняя ревизия, если она есть. История отдаётся
  // целиком: в ней и смысл дневника, а не только в текущей редакции.
  list(userId: string) {
    return this.prisma.withUser(userId, (tx) =>
      tx.decision.findMany({
        orderBy: { createdAt: 'desc' },
        include: { revisions: { orderBy: { createdAt: 'desc' } } },
      }),
    )
  }
}
