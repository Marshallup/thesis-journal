import { Money } from '@thesis/contracts'
import { Test } from '@nestjs/testing'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { DbModule } from '../src/db/db.module.ts'
import { PrismaService } from '../src/db/prisma.service.ts'
import { TradesModule } from '../src/trades/trades.module.ts'
import { TradesService } from '../src/trades/trades.service.ts'
import { withTestDb } from './setup-db.ts'

let db: Awaited<ReturnType<typeof withTestDb>>
let moduleRef: Awaited<ReturnType<typeof createModule>>
let service: TradesService
let prisma: PrismaService

async function createModule() {
  const ref = await Test.createTestingModule({ imports: [DbModule, TradesModule] }).compile()
  await ref.init()
  return ref
}

// Сидинг владельцем: RLS его не ограничивает, а через роль приложения вставка
// счёта упиралась бы в политику, которую мы же и проверяем.
async function seedAccount(email: string) {
  const user = await db.prisma.user.create({ data: { email, passwordHash: 'x' } })
  const account = await db.prisma.account.create({
    data: { userId: user.id, provider: 'manual', kind: 'manual', baseCurrency: 'RUB' },
  })
  const instrument = await db.prisma.instrument.create({
    data: { symbol: `S${Date.now()}`, class: 'equity', currency: 'RUB' },
  })
  return { userId: user.id, accountId: account.id, instrumentId: instrument.id }
}

const money = (value: unknown) => Money.of(String(value)).toString()

beforeAll(async () => {
  db = await withTestDb()
  process.env.APP_DATABASE_URL = db.appUrl
  moduleRef = await createModule()
  service = moduleRef.get(TradesService)
  prisma = moduleRef.get(PrismaService)
})

afterAll(async () => {
  await moduleRef.close()
  await db.stop()
})

it('покупка и продажа оставляют согласованные позицию и лоты', async () => {
  const { userId, accountId, instrumentId } = await seedAccount('apply@example.com')

  await service.apply(userId, {
    accountId,
    instrumentId,
    side: 'buy',
    quantity: '2',
    price: '100',
    fee: '0',
    executedAt: '2026-01-01T10:00:00Z',
  })
  await service.apply(userId, {
    accountId,
    instrumentId,
    side: 'sell',
    quantity: '1',
    price: '150',
    fee: '0',
    executedAt: '2026-02-01T10:00:00Z',
  })

  const position = await prisma.withUser(userId, (tx) =>
    tx.position.findFirstOrThrow({ where: { instrumentId } }),
  )
  const lots = await prisma.withUser(userId, (tx) => tx.lot.findMany({ where: { instrumentId } }))

  expect(money(position.quantity)).toBe('1')
  expect(money(position.realizedPnl)).toBe('50')
  expect(money(position.costBasisTotal)).toBe('100')

  // Инварианты: сумма остатков лотов равна позиции — и по количеству, и по затратам.
  const openQty = lots.reduce((acc, l) => acc.plus(money(l.qtyRemaining)), Money.of('0'))
  const openCost = lots.reduce((acc, l) => acc.plus(money(l.costRemaining)), Money.of('0'))
  expect(openQty.toString()).toBe(money(position.quantity))
  expect(openCost.toString()).toBe(money(position.costBasisTotal))
})

it('комиссия покупки входит в затраты лота, а не теряется', async () => {
  const { userId, accountId, instrumentId } = await seedAccount('fee@example.com')

  await service.apply(userId, {
    accountId,
    instrumentId,
    side: 'buy',
    quantity: '3',
    price: '100',
    fee: '10',
    executedAt: '2026-01-01T10:00:00Z',
  })

  const lots = await prisma.withUser(userId, (tx) => tx.lot.findMany({ where: { instrumentId } }))
  expect(lots).toHaveLength(1)
  expect(money(lots[0]?.price)).toBe('100')
  expect(money(lots[0]?.costOpen)).toBe('310')
  expect(money(lots[0]?.costRemaining)).toBe('310')
})

it('продажа пишет списание на каждый затронутый лот', async () => {
  const { userId, accountId, instrumentId } = await seedAccount('consumption@example.com')
  const base = { accountId, instrumentId, price: '100', fee: '0' }

  await service.apply(userId, {
    ...base,
    side: 'buy',
    quantity: '1',
    executedAt: '2026-01-01T10:00:00Z',
  })
  await service.apply(userId, {
    ...base,
    side: 'buy',
    quantity: '1',
    executedAt: '2026-01-02T10:00:00Z',
  })
  const sale = await service.apply(userId, {
    ...base,
    side: 'sell',
    quantity: '2',
    price: '150',
    executedAt: '2026-02-01T10:00:00Z',
  })

  const consumptions = await prisma.withUser(userId, (tx) =>
    tx.lotConsumption.findMany({ where: { tradeId: sale.id }, orderBy: { createdAt: 'asc' } }),
  )

  expect(consumptions).toHaveLength(2)
  const pnl = consumptions.reduce((acc, c) => acc.plus(money(c.realizedPnl)), Money.of('0'))
  expect(pnl.toString()).toBe('100')

  const lots = await prisma.withUser(userId, (tx) => tx.lot.findMany({ where: { instrumentId } }))
  expect(lots.every((l) => money(l.qtyRemaining) === '0')).toBe(true)
})

// Сбой посередине записи — не выдуманный: consumeFifo бросает «not enough
// quantity» уже после того, как сделка вставлена. Если бы позиция обновлялась
// вне транзакции, сделка осталась бы в базе без своей позиции.
it('неудачная продажа не оставляет ни сделки, ни изменения позиции', async () => {
  const { userId, accountId, instrumentId } = await seedAccount('rollback@example.com')
  const base = { accountId, instrumentId, fee: '0' }

  await service.apply(userId, {
    ...base,
    side: 'buy',
    quantity: '1',
    price: '100',
    executedAt: '2026-01-01T10:00:00Z',
  })

  await expect(
    service.apply(userId, {
      ...base,
      side: 'sell',
      quantity: '5',
      price: '150',
      executedAt: '2026-02-01T10:00:00Z',
    }),
  ).rejects.toThrow('not enough quantity')

  const trades = await prisma.withUser(userId, (tx) =>
    tx.trade.findMany({ where: { instrumentId } }),
  )
  const position = await prisma.withUser(userId, (tx) =>
    tx.position.findFirstOrThrow({ where: { instrumentId } }),
  )

  expect(trades.map((t) => t.side)).toEqual(['buy'])
  expect(money(position.quantity)).toBe('1')
  expect(money(position.realizedPnl)).toBe('0')
})
