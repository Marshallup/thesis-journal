import { randomUUID } from 'node:crypto'
import { ConfigService } from '@nestjs/config'
import { Test } from '@nestjs/testing'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { ApplyImportService } from '../src/imports/apply-import.service.ts'
import { DbModule } from '../src/db/db.module.ts'
import { ImportsConsumer } from '../src/imports/imports.consumer.ts'
import { ImportsModule } from '../src/imports/imports.module.ts'
import { PrismaService } from '../src/db/prisma.service.ts'
import { RabbitPublisher } from '../src/rabbit/rabbit.publisher.ts'
import type { Env } from '../src/config/env.ts'
import type { ImportParsed, RawOperation } from '@thesis/contracts'
import { withTestDb } from './setup-db.ts'

let db: Awaited<ReturnType<typeof withTestDb>>
let moduleRef: Awaited<ReturnType<typeof createModule>>
let prisma: PrismaService
let consumer: ImportsConsumer

// Брокер в тестах не поднимается: проверяется то, что делает консьюмер, а не
// доставка Kafka.
const configStub = { get: () => 'localhost:9092' } as unknown as ConfigService<Env, true>

async function createModule() {
  const ref = await Test.createTestingModule({ imports: [DbModule, ImportsModule] })
    .overrideProvider(RabbitPublisher)
    .useValue({ send: () => {} })
    .compile()
  await ref.init()
  return ref
}

async function seedAccount() {
  const user = await db.prisma.user.create({
    data: { email: `sync-${randomUUID()}@example.com`, passwordHash: 'x' },
  })
  const account = await db.prisma.account.create({
    data: { userId: user.id, provider: 'bybit', kind: 'exchange', baseCurrency: 'USDT' },
  })
  return { userId: user.id, accountId: account.id }
}

// Операции такие, какими их отдаёт коннектор: крипта, валюта пары, комиссия
// отдельным полем.
function executions(): RawOperation[] {
  return [
    {
      kind: 'trade',
      side: 'buy',
      ticker: 'BTCUSDT',
      instrumentClass: 'crypto',
      quantity: '0.01',
      price: '64000',
      fee: '0.64',
      currency: 'USDT',
      executedAt: '2026-10-01T10:00:00.000Z',
      externalId: 'exec-1',
    },
    {
      kind: 'trade',
      side: 'sell',
      ticker: 'BTCUSDT',
      instrumentClass: 'crypto',
      quantity: '0.004',
      price: '65000',
      fee: '0.26',
      currency: 'USDT',
      executedAt: '2026-10-02T10:00:00.000Z',
      externalId: 'exec-2',
    },
  ]
}

function event(seed: { userId: string; accountId: string }, fileHash: string): ImportParsed {
  return {
    importId: randomUUID(),
    accountId: seed.accountId,
    userId: seed.userId,
    source: 'bybit',
    fileHash,
    operations: executions(),
  }
}

beforeAll(async () => {
  db = await withTestDb()
  process.env.APP_DATABASE_URL = db.appUrl
  moduleRef = await createModule()
  prisma = moduleRef.get(PrismaService)
  consumer = new ImportsConsumer(prisma, moduleRef.get(ApplyImportService), configStub)
})

afterAll(async () => {
  await moduleRef.close()
  await db.stop()
})

// У синхронизации нет загрузки файла, значит строку импорта создаёт консьюмер:
// хеш выборки известен только после ответа биржи.
it('событие синхронизации создаёт строку импорта и применяет сделки', async () => {
  const seed = await seedAccount()

  await consumer.handle(randomUUID(), event(seed, `hash-${randomUUID()}`))

  const imports = await db.prisma.import.findMany({ where: { accountId: seed.accountId } })
  expect(imports).toHaveLength(1)
  expect(imports[0]?.source).toBe('bybit')
  expect(imports[0]?.status).toBe('parsed')
  expect(imports[0]?.result).toMatchObject({ created: 2 })

  const trades = await db.prisma.trade.findMany({ where: { accountId: seed.accountId } })
  expect(trades).toHaveLength(2)
  // Инструмент создан как крипта: в справочнике тикер уникален парой с классом.
  const instrument = await db.prisma.instrument.findFirstOrThrow({ where: { symbol: 'BTCUSDT' } })
  expect(instrument.class).toBe('crypto')
  expect(instrument.currency).toBe('USDT')
})

// Биржа отдала ту же выборку второй раз: это не ошибка, а ответ «нового нет».
// Второй строки импорта быть не должно, сделок — тоже.
it('та же выборка биржи не создаёт второй импорт', async () => {
  const seed = await seedAccount()
  const fileHash = `hash-${randomUUID()}`

  await consumer.handle(randomUUID(), event(seed, fileHash))
  // Другое событие, другой importId — но та же выборка.
  await consumer.handle(randomUUID(), event(seed, fileHash))

  expect(await db.prisma.import.count({ where: { accountId: seed.accountId } })).toBe(1)
  expect(await db.prisma.trade.count({ where: { accountId: seed.accountId } })).toBe(2)
})

// Повторная доставка того же события не должна применяться второй раз — это
// дедупликация по идентификатору, а не по содержимому.
it('повтор того же события ничего не добавляет', async () => {
  const seed = await seedAccount()
  const eventId = randomUUID()
  const parsed = event(seed, `hash-${randomUUID()}`)

  await consumer.handle(eventId, parsed)
  await consumer.handle(eventId, parsed)

  expect(await db.prisma.import.count({ where: { accountId: seed.accountId } })).toBe(1)
  expect(await db.prisma.trade.count({ where: { accountId: seed.accountId } })).toBe(2)
})
