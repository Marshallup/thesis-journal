import { Injectable } from '@nestjs/common'
import { PrismaService } from '../db/prisma.service.ts'

export type ContextSnapshot = {
  capturedAt: string // ISO, UTC
  localHour: number // час по МСК — для среза «сделки ночью»
  weekday: number // 0..6, воскресенье — 0
  tradesLast24h: number
  portfolioDrawdownPct: string | null // строка, не number
}

const DAY_MS = 24 * 60 * 60 * 1000

// Части московского календаря берутся через Intl, а не прибавлением трёх
// часов: смещение зоны — не константа на все времена, и привычка прибавлять
// часы сломается на первой же другой зоне.
const moscow = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Moscow',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  hour12: false,
})

function moscowParts(moment: Date): { year: number; month: number; day: number; hour: number } {
  const parts = new Map(moscow.formatToParts(moment).map((part) => [part.type, part.value]))
  return {
    year: Number(parts.get('year')),
    month: Number(parts.get('month')),
    day: Number(parts.get('day')),
    // В en-GB полночь приходит как «24», а не «00».
    hour: Number(parts.get('hour')) % 24,
  }
}

@Injectable()
export class ContextSnapshotService {
  constructor(private readonly prisma: PrismaService) {}

  // now приходит аргументом: иначе тест недетерминирован, а снимок нельзя
  // воспроизвести при разборе.
  async build(
    userId: string,
    accountId: string,
    instrumentId: string,
    now: Date,
  ): Promise<ContextSnapshot> {
    const { year, month, day, hour } = moscowParts(now)
    // День недели считается от московской календарной даты, а не от Date.getDay(),
    // который вернул бы день по зоне сервера.
    const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay()

    const tradesLast24h = await this.prisma.withUser(userId, (tx) =>
      tx.trade.count({
        where: { accountId, executedAt: { gte: new Date(now.getTime() - DAY_MS), lte: now } },
      }),
    )

    // instrumentId входит в подпись по плану, но пока не используется: просадка
    // портфельная, а не по инструменту. Останется для ключа news из v2.
    void instrumentId

    return {
      capturedAt: now.toISOString(),
      localHour: hour,
      weekday,
      tradesLast24h,
      // Просадка требует рыночной цены, которой в проекте пока нет: нереализованный
      // P&L считается из последней цены в Redis (§2 спека), а цены приедут с
      // коннекторами на неделе 4. Поле остаётся null, а не заполняется выдумкой.
      portfolioDrawdownPct: null,
    }
  }
}
