import { Test } from '@nestjs/testing'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { DbModule } from '../src/db/db.module.ts'
import { ContextSnapshotService } from '../src/decisions/context-snapshot.service.ts'
import { DecisionsModule } from '../src/decisions/decisions.module.ts'
import { withTestDb } from './setup-db.ts'

let db: Awaited<ReturnType<typeof withTestDb>>
let moduleRef: Awaited<ReturnType<typeof createModule>>
let service: ContextSnapshotService

async function createModule() {
  const ref = await Test.createTestingModule({ imports: [DbModule, DecisionsModule] }).compile()
  await ref.init()
  return ref
}

async function seedAccount(email: string) {
  const user = await db.prisma.user.create({ data: { email, passwordHash: 'x' } })
  const account = await db.prisma.account.create({
    data: { userId: user.id, provider: 'manual', kind: 'manual', baseCurrency: 'RUB' },
  })
  const instrument = await db.prisma.instrument.create({
    data: {
      symbol: `S${Math.random().toString(36).slice(2, 8)}`,
      class: 'equity',
      currency: 'RUB',
    },
  })
  return { userId: user.id, accountId: account.id, instrumentId: instrument.id }
}

async function seedTrades(accountId: string, instrumentId: string, executedAt: string[]) {
  for (const moment of executedAt) {
    await db.prisma.trade.create({
      data: {
        accountId,
        instrumentId,
        side: 'buy',
        quantity: '1',
        price: '100',
        fee: '0',
        feeCurrency: 'RUB',
        executedAt: new Date(moment),
        provider: 'manual',
      },
    })
  }
}

beforeAll(async () => {
  db = await withTestDb()
  process.env.APP_DATABASE_URL = db.appUrl
  moduleRef = await createModule()
  service = moduleRef.get(ContextSnapshotService)
})

afterAll(async () => {
  await moduleRef.close()
  await db.stop()
})

it('считает число сделок за сутки и час по Москве', async () => {
  const { userId, accountId, instrumentId } = await seedAccount('snapshot@example.com')
  await seedTrades(accountId, instrumentId, [
    '2026-03-01T21:30:00Z', // 00:30 по МСК следующего дня
    '2026-03-02T05:00:00Z',
  ])

  const snap = await service.build(
    userId,
    accountId,
    instrumentId,
    new Date('2026-03-02T06:00:00Z'),
  )

  expect(snap.tradesLast24h).toBe(2)
  expect(snap.localHour).toBe(9) // 06:00 UTC = 09:00 MSK
})

// Сутки считаются от переданного now, а не от момента запуска теста.
it('не считает сделку старше суток', async () => {
  const { userId, accountId, instrumentId } = await seedAccount('older@example.com')
  await seedTrades(accountId, instrumentId, [
    '2026-02-28T12:00:00Z', // двое суток назад
    '2026-03-02T05:00:00Z',
  ])

  const snap = await service.build(
    userId,
    accountId,
    instrumentId,
    new Date('2026-03-02T06:00:00Z'),
  )

  expect(snap.tradesLast24h).toBe(1)
})

// Москва летом и зимой — одно смещение, но брать его через Intl всё равно
// обязательно: прибавление трёх часов сломается на любой другой зоне.
it('даёт день недели по московскому календарю, а не по серверному', async () => {
  const { userId, accountId, instrumentId } = await seedAccount('weekday@example.com')

  // 22:30 UTC в воскресенье — это уже 01:30 понедельника по Москве.
  const snap = await service.build(
    userId,
    accountId,
    instrumentId,
    new Date('2026-03-01T22:30:00Z'),
  )

  expect(snap.localHour).toBe(1)
  expect(snap.weekday).toBe(1) // понедельник
})

it('не выдумывает просадку, пока нет рыночных цен', async () => {
  const { userId, accountId, instrumentId } = await seedAccount('drawdown@example.com')

  const snap = await service.build(userId, accountId, instrumentId, new Date())

  expect(snap.portfolioDrawdownPct).toBeNull()
})
