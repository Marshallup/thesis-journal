import { Test } from '@nestjs/testing'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { DbModule } from '../src/db/db.module.ts'
import { DecisionsModule } from '../src/decisions/decisions.module.ts'
import { DecisionsService } from '../src/decisions/decisions.service.ts'
import { PrismaService } from '../src/db/prisma.service.ts'
import { withTestDb } from './setup-db.ts'

let db: Awaited<ReturnType<typeof withTestDb>>
let moduleRef: Awaited<ReturnType<typeof createModule>>
let service: DecisionsService
let prisma: PrismaService

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

// accountId, instrumentId и side в списке полей плана отсутствовали, но их
// требует матчинг из задачи 11, и без accountId решению не на чем построить
// политику RLS.
const draft = (accountId: string, instrumentId: string) => ({
  accountId,
  instrumentId,
  side: 'buy' as const,
  horizonDays: 90,
  conviction: 4,
  mood: 'calm',
})

beforeAll(async () => {
  db = await withTestDb()
  process.env.APP_DATABASE_URL = db.appUrl
  moduleRef = await createModule()
  service = moduleRef.get(DecisionsService)
  prisma = moduleRef.get(PrismaService)
})

afterAll(async () => {
  await moduleRef.close()
  await db.stop()
})

it('не даёт переписать тезис задним числом даже в обход сервиса', async () => {
  const { userId, accountId, instrumentId } = await seedAccount('immutable@example.com')
  const decision = await service.create(userId, {
    ...draft(accountId, instrumentId),
    thesis: 'беру на просадке, жду отчёт',
    invalidator: 'отчёт хуже прогноза',
  })

  // Через db.prisma, то есть владельцем базы: RLS он обходит, а триггер — нет.
  await expect(
    db.prisma
      .$executeRaw`update decisions set thesis = 'я так и знал' where id = ${decision.id}::uuid`,
  ).rejects.toThrow(/immutable/)
})

it('правка создаёт ревизию, исходный тезис остаётся', async () => {
  const { userId, accountId, instrumentId } = await seedAccount('revise@example.com')
  const decision = await service.create(userId, {
    ...draft(accountId, instrumentId),
    thesis: 'первая версия',
  })

  await service.revise(userId, decision.id, { thesis: 'вторая версия' })

  const revisions = await prisma.withUser(userId, (tx) =>
    tx.decisionRevision.findMany({ where: { decisionId: decision.id } }),
  )
  const original = await prisma.withUser(userId, (tx) =>
    tx.decision.findUniqueOrThrow({ where: { id: decision.id } }),
  )

  expect(revisions).toHaveLength(1)
  expect(revisions[0]?.thesis).toBe('вторая версия')
  // Поля, которых в правке не было, переносятся из исходного снимка.
  expect(revisions[0]?.conviction).toBe(4)
  expect(original.thesis).toBe('первая версия')
})

// Триггер запрещает всё, кроме unrealized: его выставляет матчинг из задачи 11,
// когда горизонт решения истёк без сделок. Если запрет окажется шире, задача 11
// упрётся в него, и это надо знать сейчас, а не через неделю.
it('оставляет unrealized изменяемым — его пишет матчинг', async () => {
  const { userId, accountId, instrumentId } = await seedAccount('unrealized@example.com')
  const decision = await service.create(userId, {
    ...draft(accountId, instrumentId),
    thesis: 'горизонт истечёт без сделки',
  })

  await db.prisma.decision.update({ where: { id: decision.id }, data: { unrealized: true } })

  const updated = await prisma.withUser(userId, (tx) =>
    tx.decision.findUniqueOrThrow({ where: { id: decision.id } }),
  )
  expect(updated.unrealized).toBe(true)
})

it('не принимает уверенность вне шкалы 1–5', async () => {
  const { userId, accountId, instrumentId } = await seedAccount('conviction@example.com')

  await expect(
    service.create(userId, {
      ...draft(accountId, instrumentId),
      conviction: 9,
      thesis: 'шкала от одного до пяти',
    }),
  ).rejects.toThrow()
})
