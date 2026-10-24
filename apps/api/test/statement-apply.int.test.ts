import { randomUUID } from 'node:crypto'
import { Test } from '@nestjs/testing'
import { Money } from '@thesis/contracts'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { ApplyImportService } from '../src/imports/apply-import.service.ts'
import { DbModule } from '../src/db/db.module.ts'
import { ImportsModule } from '../src/imports/imports.module.ts'
import { PortfolioModule } from '../src/portfolio/portfolio.module.ts'
import { PortfolioService } from '../src/portfolio/portfolio.service.ts'
import { RabbitPublisher } from '../src/rabbit/rabbit.publisher.ts'
import type { RawOperation } from '@thesis/contracts'
import { withTestDb } from './setup-db.ts'

let db: Awaited<ReturnType<typeof withTestDb>>
let moduleRef: Awaited<ReturnType<typeof createModule>>
let service: ApplyImportService

async function createModule() {
  const ref = await Test.createTestingModule({
    imports: [DbModule, ImportsModule, PortfolioModule],
  })
    .overrideProvider(RabbitPublisher)
    .useValue({ send: () => {} })
    .compile()
  await ref.init()
  return ref
}

async function seedStatement() {
  const user = await db.prisma.user.create({
    data: { email: `statement-${randomUUID()}@example.com`, passwordHash: 'x' },
  })
  const account = await db.prisma.account.create({
    data: { userId: user.id, provider: 'bybit', kind: 'exchange', baseCurrency: 'USDT' },
  })
  const row = await db.prisma.import.create({
    data: {
      accountId: account.id,
      // Источник именно выгрузки: у синхронизации по API он другой, и
      // провайдер сделок зависит от него.
      source: 'bybit-statement',
      fileHash: randomUUID(),
      status: 'uploaded',
    },
  })
  return { userId: user.id, accountId: account.id, importId: row.id }
}

const arrival = (quantity: string, when: string): RawOperation => ({
  kind: 'arrival',
  ticker: 'BTCUSDT',
  instrumentClass: 'crypto',
  quantity,
  currency: 'USDT',
  executedAt: when,
  externalId: `deposit-${when}`,
})

const sale = (quantity: string, price: string, when: string): RawOperation => ({
  kind: 'trade',
  side: 'sell',
  ticker: 'BTCUSDT',
  instrumentClass: 'crypto',
  quantity,
  price,
  fee: '0',
  currency: 'USDT',
  executedAt: when,
  externalId: `sell-${when}`,
})

beforeAll(async () => {
  db = await withTestDb()
  process.env.APP_DATABASE_URL = db.appUrl
  moduleRef = await createModule()
  service = moduleRef.get(ApplyImportService)
})

afterAll(async () => {
  await moduleRef.close()
  await db.stop()
})

// Монета пришла депозитом: цены покупки у неё нет, и лот записывается нулевым
// под пометкой. Без этого продажа такой монеты висела бы отложенной навсегда.
it('приход монеты становится лотом с нулевой себестоимостью и пометкой', async () => {
  const seed = await seedStatement()

  const result = await service.apply(seed.userId, seed.importId, [
    arrival('0.03293147', '2024-11-21T09:28:08.000Z'),
  ])

  expect(result).toMatchObject({ created: 1, arrivals: 1, skipped: 0 })
  const trade = await db.prisma.trade.findFirstOrThrow({ where: { accountId: seed.accountId } })
  expect(trade.costUnknown).toBe(true)
  expect(Money.of(trade.price.toString()).toString()).toBe('0')
  // Провайдер свой: иначе граница по дате поехала бы с каждым импортом.
  expect(trade.provider).toBe('bybit-statement')

  const lot = await db.prisma.lot.findFirstOrThrow({ where: { accountId: seed.accountId } })
  expect(Money.of(lot.costOpen.toString()).toString()).toBe('0')
  expect(Money.of(lot.qtyRemaining.toString()).toString()).toBe('0.03293147')
})

// То, ради чего всё это: продажа монеты, пришедшей депозитом, применяется, а
// не откладывается. Прибыль при этом равна всей выручке — себестоимости нет.
it('продажа после прихода применяется и даёт прибыль в размере выручки', async () => {
  const seed = await seedStatement()

  const result = await service.apply(seed.userId, seed.importId, [
    arrival('0.031878', '2024-11-21T09:28:08.000Z'),
    sale('0.031878', '99500', '2024-12-05T02:32:16.000Z'),
  ])

  expect(result.deferred).toEqual([])
  expect(result).toMatchObject({ created: 2, arrivals: 1 })

  const position = await db.prisma.position.findFirstOrThrow({
    where: { accountId: seed.accountId },
  })
  expect(Money.of(position.quantity.toString()).toString()).toBe('0')
  // 0.031878 × 99500 = 3171.861, себестоимость ноль.
  expect(Money.of(position.realizedPnl.toString()).toString()).toBe('3171.861')
})

// Пропущенное разборщиком хранится рядом с итогом: «импортировано N сделок»
// без числа пропущенных производных — правда, вводящая в заблуждение.
it('итог импорта хранит пропущенное разборщиком', async () => {
  const seed = await seedStatement()

  await service.apply(seed.userId, seed.importId, [arrival('0.001', '2024-11-16T04:21:48.000Z')], {
    derivatives: 4558,
    newer: 301,
    withdrawals: 5,
    unknownFiles: [],
  })

  const row = await db.prisma.import.findUniqueOrThrow({ where: { id: seed.importId } })
  expect(row.result).toMatchObject({
    created: 1,
    arrivals: 1,
    skippedRows: { derivatives: 4558, newer: 301, withdrawals: 5 },
  })
})

// Повторная заливка той же выгрузки не задваивает приход: ключ идемпотентности
// у него свой, собранный из содержимого строки.
it('повторный приход не задваивается', async () => {
  const seed = await seedStatement()
  const operations = [arrival('0.001', '2024-11-16T04:21:48.000Z')]

  await service.apply(seed.userId, seed.importId, operations)
  const second = await service.apply(seed.userId, seed.importId, operations)

  expect(second).toMatchObject({ created: 0, skipped: 1, arrivals: 0 })
  expect(await db.prisma.lot.count({ where: { accountId: seed.accountId } })).toBe(1)
})

// Прибыль по монете без себестоимости завышена на всю её стоимость, и это
// обязано быть видно отдельной строкой: иначе число на экране выглядит
// заработком, которым не является. Поймано на живых данных 24.10.2026, когда
// итог по счёту вырос до +4473 USDT, из которых 3832 — ровно этот случай.
it('реализованное по приходам считается отдельно от настоящих покупок', async () => {
  const seed = await seedStatement()

  await service.apply(seed.userId, seed.importId, [
    arrival('0.001', '2024-11-16T04:21:48.000Z'),
    sale('0.001', '100000', '2024-12-05T02:32:16.000Z'),
  ])

  const portfolio = moduleRef.get(PortfolioService)
  const { accounts } = await portfolio.summary(seed.userId)
  const account = accounts.find((item) => item.accountId === seed.accountId)!

  expect(Money.of(account.realizedPnl).toString()).toBe('100')
  // Вся сотня — от монеты, которой не покупали.
  expect(Money.of(account.realizedWithoutCost).toString()).toBe('100')
})
