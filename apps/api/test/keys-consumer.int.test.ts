import { randomUUID } from 'node:crypto'
import { ConfigService } from '@nestjs/config'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { KeysConsumer } from '../src/keys/keys.consumer.ts'
import { PrismaService } from '../src/db/prisma.service.ts'
import type { Env } from '../src/config/env.ts'
import type { ExchangeKeyChecked } from '@thesis/contracts'
import { withTestDb } from './setup-db.ts'

let db: Awaited<ReturnType<typeof withTestDb>>
let prisma: PrismaService
let consumer: KeysConsumer

// Брокер в тестах не поднимается: проверяется транзакция, в которой живёт вся
// идемпотентность, а не обещание Kafka доставить сообщение.
const configStub = { get: () => 'localhost:9092' } as unknown as ConfigService<Env, true>

async function seedKey() {
  const user = await db.prisma.user.create({
    data: { email: `checked-${randomUUID()}@example.com`, passwordHash: 'x' },
  })
  const account = await db.prisma.account.create({
    data: { userId: user.id, provider: 'bybit', kind: 'exchange', baseCurrency: 'USDT' },
  })
  const key = await db.prisma.apiKey.create({
    data: {
      accountId: account.id,
      exchange: 'bybit',
      keyMask: 'bybi…7f3a',
      status: 'unverified',
    },
  })
  return { userId: user.id, accountId: account.id, keyId: key.id }
}

function checked(seed: { userId: string; accountId: string }, status: 'active' | 'rejected') {
  const event: ExchangeKeyChecked = {
    accountId: seed.accountId,
    userId: seed.userId,
    exchange: 'bybit',
    status,
    scopes: status === 'active' ? ['Exchange:ExchangeHistory'] : ['Spot:SpotTrade'],
    checkedAt: '2026-10-23T10:00:00.000Z',
    ...(status === 'rejected' ? { reason: 'ключ умеет торговать' } : {}),
  }
  return event
}

beforeAll(async () => {
  db = await withTestDb()
  process.env.APP_DATABASE_URL = db.appUrl
  prisma = new PrismaService()
  await prisma.$connect()
  consumer = new KeysConsumer(prisma, configStub)
})

afterAll(async () => {
  await prisma.$disconnect()
  await db.stop()
})

it('проверенный ключ становится активным, права видны', async () => {
  const seed = await seedKey()

  await consumer.apply(randomUUID(), checked(seed, 'active'))

  const row = await db.prisma.apiKey.findUniqueOrThrow({ where: { id: seed.keyId } })
  expect(row.status).toBe('active')
  expect(row.permissions).toEqual(['Exchange:ExchangeHistory'])
  expect(row.verifiedAt?.toISOString()).toBe('2026-10-23T10:00:00.000Z')
  expect(row.error).toBeNull()
})

// «Отклонён» без объяснения — тупик: человек не знает, какие галочки снять.
it('отклонённый ключ хранит причину отказа', async () => {
  const seed = await seedKey()

  await consumer.apply(randomUUID(), checked(seed, 'rejected'))

  const row = await db.prisma.apiKey.findUniqueOrThrow({ where: { id: seed.keyId } })
  expect(row.status).toBe('rejected')
  expect(row.error).toContain('торговать')
})

// Повторная доставка того же события не должна применяться второй раз. Тест
// подменяет содержимое при том же идентификаторе: без дедупликации статус
// сменился бы на второй, и это видно.
it('повтор того же события с другим содержимым ничего не меняет', async () => {
  const seed = await seedKey()
  const eventId = randomUUID()

  await consumer.apply(eventId, checked(seed, 'active'))
  await consumer.apply(eventId, checked(seed, 'rejected'))

  const row = await db.prisma.apiKey.findUniqueOrThrow({ where: { id: seed.keyId } })
  expect(row.status).toBe('active')
  expect(row.error).toBeNull()
})

// Событие с чужим счётом не должно менять чужой ключ: статус пишется под RLS,
// и подделанный accountId не попадает ни в одну строку.
it('событие с чужим счётом не трогает чужой ключ', async () => {
  const mine = await seedKey()
  const theirs = await seedKey()

  await consumer.apply(randomUUID(), {
    ...checked(theirs, 'rejected'),
    userId: mine.userId,
  })

  const row = await db.prisma.apiKey.findUniqueOrThrow({ where: { id: theirs.keyId } })
  expect(row.status).toBe('unverified')
  expect(row.verifiedAt).toBeNull()
})
