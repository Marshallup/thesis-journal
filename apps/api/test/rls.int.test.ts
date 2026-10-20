import { Test } from '@nestjs/testing'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { DbModule } from '../src/db/db.module.ts'
import { PrismaService } from '../src/db/prisma.service.ts'
import { withTestDb } from './setup-db.ts'

let db: Awaited<ReturnType<typeof withTestDb>>
let moduleRef: Awaited<ReturnType<typeof createModule>>
let prisma: PrismaService
let instrumentId: string

// PrismaService читает APP_DATABASE_URL в конструкторе, поэтому адрес роли
// должен стоять до compile(), а не до init().
async function createModule() {
  const ref = await Test.createTestingModule({ imports: [DbModule] }).compile()
  await ref.init()
  return ref
}

// Сидинг идёт владельцем: RLS его не ограничивает. Через роль приложения
// вставка упиралась бы в ту же политику, которую тест и проверяет.
async function createUserWithTrade(email: string) {
  const user = await db.prisma.user.create({
    data: { email, passwordHash: 'not-a-real-hash' },
  })
  const account = await db.prisma.account.create({
    data: { userId: user.id, provider: 'manual', kind: 'manual', baseCurrency: 'RUB' },
  })
  await db.prisma.trade.create({
    data: {
      accountId: account.id,
      instrumentId,
      side: 'buy',
      // Деньги в фикстурах — строки.
      quantity: '10',
      price: '250.50',
      fee: '1.25',
      feeCurrency: 'RUB',
      executedAt: new Date('2026-03-02T06:00:00Z'),
      provider: 'manual',
    },
  })
  return { id: user.id, accountId: account.id }
}

beforeAll(async () => {
  db = await withTestDb()
  process.env.APP_DATABASE_URL = db.appUrl
  moduleRef = await createModule()
  prisma = moduleRef.get(PrismaService)

  // Справочник общий: политик на него нет, одного инструмента хватает обоим.
  const instrument = await db.prisma.instrument.create({
    data: { symbol: 'SBER', class: 'equity', currency: 'RUB' },
  })
  instrumentId = instrument.id
})

afterAll(async () => {
  await moduleRef.close()
  await db.stop()
})

it('не показывает сделки чужого пользователя даже при запросе без фильтра', async () => {
  const alice = await createUserWithTrade('alice@example.com')
  const bob = await createUserWithTrade('bob@example.com')

  const seenByAlice = await prisma.withUser(alice.id, (tx) => tx.trade.findMany())

  expect(seenByAlice).toHaveLength(1)
  expect(seenByAlice[0]?.accountId).toBe(alice.accountId)
  expect(seenByAlice.map((t) => t.accountId)).not.toContain(bob.accountId)
})
