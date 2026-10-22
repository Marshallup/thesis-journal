import { Test } from '@nestjs/testing'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { DbModule } from '../src/db/db.module.ts'
import { PrismaService } from '../src/db/prisma.service.ts'
import { DecisionsModule } from '../src/decisions/decisions.module.ts'
import { DecisionsService } from '../src/decisions/decisions.service.ts'
import { MatchingService } from '../src/decisions/matching.service.ts'
import { TradesModule } from '../src/trades/trades.module.ts'
import { TradesService } from '../src/trades/trades.service.ts'
import { withTestDb } from './setup-db.ts'

let db: Awaited<ReturnType<typeof withTestDb>>
let moduleRef: Awaited<ReturnType<typeof createModule>>
let decisions: DecisionsService
let trades: TradesService
let matching: MatchingService
let prisma: PrismaService

async function createModule() {
  const ref = await Test.createTestingModule({
    imports: [DbModule, DecisionsModule, TradesModule],
  }).compile()
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

const buy = (accountId: string, instrumentId: string, executedAt: string) => ({
  accountId,
  instrumentId,
  side: 'buy' as const,
  quantity: '1',
  price: '100',
  fee: '0',
  executedAt,
})

const thesis = (accountId: string, instrumentId: string, horizonDays = 7) => ({
  accountId,
  instrumentId,
  side: 'buy' as const,
  thesis: 'беру на просадке',
  horizonDays,
  conviction: 4,
  mood: 'calm' as const,
})

const links = (userId: string) =>
  prisma.withUser(userId, (tx) => tx.decisionTrade.findMany({ orderBy: { createdAt: 'asc' } }))

beforeAll(async () => {
  db = await withTestDb()
  process.env.APP_DATABASE_URL = db.appUrl
  moduleRef = await createModule()
  decisions = moduleRef.get(DecisionsService)
  trades = moduleRef.get(TradesService)
  matching = moduleRef.get(MatchingService)
  prisma = moduleRef.get(PrismaService)
})

afterAll(async () => {
  await moduleRef.close()
  await db.stop()
})

it('привязывает сделку к решению сама, когда кандидат один', async () => {
  const { userId, accountId, instrumentId } = await seedAccount('auto@example.com')
  const decision = await decisions.create(userId, thesis(accountId, instrumentId))

  const trade = await trades.apply(
    userId,
    buy(accountId, instrumentId, isoSoonAfter(decision.createdAt)),
  )

  const created = await links(userId)
  expect(created).toHaveLength(1)
  expect(created[0]?.decisionId).toBe(decision.id)
  expect(created[0]?.tradeId).toBe(trade.id)
})

// Инвариант §2.1: решение записывается до сделки. Сделка, совершённая раньше,
// не привязывается никогда — иначе дневник превращается в рационализацию.
it('не привязывает сделку, совершённую до записи решения', async () => {
  const { userId, accountId, instrumentId } = await seedAccount('before@example.com')
  await trades.apply(userId, buy(accountId, instrumentId, '2026-01-01T10:00:00Z'))

  await decisions.create(userId, thesis(accountId, instrumentId))

  expect(await links(userId)).toHaveLength(0)
})

it('не гадает между двумя кандидатами — не привязывает ни одного', async () => {
  const { userId, accountId, instrumentId } = await seedAccount('ambiguous@example.com')
  const decision = await decisions.create(userId, thesis(accountId, instrumentId))
  const first = isoSoonAfter(decision.createdAt)
  const second = isoSoonAfter(decision.createdAt, 2)

  await trades.apply(userId, buy(accountId, instrumentId, first))
  await trades.apply(userId, buy(accountId, instrumentId, second))

  // Первая сделка привязалась одна-единственная, вторая сделала выбор
  // неоднозначным — и второй связи не появилось.
  expect(await links(userId)).toHaveLength(1)
})

it('помечает решение нереализованным, когда горизонт истёк без сделок', async () => {
  const { userId, accountId, instrumentId } = await seedAccount('expired@example.com')
  const decision = await decisions.create(userId, thesis(accountId, instrumentId, 1))

  const later = new Date(decision.createdAt.getTime() + 3 * 24 * 60 * 60 * 1000)
  await matching.markExpired(userId, later)

  const updated = await prisma.withUser(userId, (tx) =>
    tx.decision.findUniqueOrThrow({ where: { id: decision.id } }),
  )
  expect(updated.unrealized).toBe(true)
})

// Время считается от переданного значения, а не от new Date() внутри кода.
function isoSoonAfter(moment: Date, hours = 1): string {
  return new Date(moment.getTime() + hours * 60 * 60 * 1000).toISOString()
}

// --- Задача 27: сроки и учёт бездействия --------------------------------

// Решение задним числом пишется про уже случившуюся сделку. Непривязанная
// сделка у него — пробел разметки, а не бездействие: «решил и не сделал» про
// него неправда.
it('не считает несовершённым решение, записанное задним числом', async () => {
  const { userId, accountId, instrumentId } = await seedAccount('postfactum@example.com')
  const decision = await decisions.create(userId, {
    ...thesis(accountId, instrumentId, 1),
    postFactum: true,
  })

  const later = new Date(decision.createdAt.getTime() + 3 * 24 * 60 * 60 * 1000)
  await matching.markExpired(userId, later)

  const updated = await prisma.withUser(userId, (tx) =>
    tx.decision.findUniqueOrThrow({ where: { id: decision.id } }),
  )
  expect(updated.unrealized).toBe(false)
})

// Решение со сделкой исполнено, и срок к нему больше не применим.
it('не трогает решение, у которого сделка есть', async () => {
  const { userId, accountId, instrumentId } = await seedAccount('executed@example.com')
  const decision = await decisions.create(userId, thesis(accountId, instrumentId, 1))
  await trades.apply(userId, buy(accountId, instrumentId, isoSoonAfter(decision.createdAt)))
  expect(await links(userId)).toHaveLength(1)

  const later = new Date(decision.createdAt.getTime() + 3 * 24 * 60 * 60 * 1000)
  await matching.markExpired(userId, later)

  const updated = await prisma.withUser(userId, (tx) =>
    tx.decision.findUniqueOrThrow({ where: { id: decision.id } }),
  )
  expect(updated.unrealized).toBe(false)
})

// Срок удержания — отдельное поле, и оно обязано доезжать до базы и обратно.
// У продажи его нет: держать после продажи нечего.
it('срок удержания сохраняется и возвращается в ленту', async () => {
  const { userId, accountId, instrumentId } = await seedAccount('hold@example.com')
  await decisions.create(userId, { ...thesis(accountId, instrumentId), holdDays: 365 })

  const [listed] = await decisions.list(userId)

  expect(listed?.holdDays).toBe(365)
  // Срок на исполнение — другое число и другое поле: их разделение и было
  // смыслом задачи 27.
  expect(listed?.horizonDays).toBe(7)
})

// Закрытое множество значений держит база, а не только Zod: колонку правит и
// импорт, и будущие воркеры.
it('база отклоняет неизвестное настроение', async () => {
  const { userId, accountId, instrumentId } = await seedAccount('mood@example.com')

  await expect(
    db.prisma.decision.create({
      data: {
        accountId,
        instrumentId,
        side: 'buy',
        thesis: 'настроение не из списка',
        horizonDays: 7,
        conviction: 3,
        mood: 'весело',
      },
    }),
  ).rejects.toThrow()

  // И ни одной записи не появилось.
  const all = await prisma.withUser(userId, (tx) => tx.decision.findMany())
  expect(all).toHaveLength(0)
})
