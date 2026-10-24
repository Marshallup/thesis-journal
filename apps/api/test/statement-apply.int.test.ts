import { randomUUID } from 'node:crypto'
import { Test } from '@nestjs/testing'
import { Money } from '@thesis/contracts'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { ApplyImportService } from '../src/imports/apply-import.service.ts'
import { DbModule } from '../src/db/db.module.ts'
import { ImportsModule } from '../src/imports/imports.module.ts'
import { PortfolioModule } from '../src/portfolio/portfolio.module.ts'
import { PortfolioService } from '../src/portfolio/portfolio.service.ts'
import { TradesService } from '../src/trades/trades.service.ts'
import { RabbitPublisher } from '../src/rabbit/rabbit.publisher.ts'
import { TradesModule } from '../src/trades/trades.module.ts'
import type { RawOperation } from '@thesis/contracts'
import { withTestDb } from './setup-db.ts'

let db: Awaited<ReturnType<typeof withTestDb>>
let moduleRef: Awaited<ReturnType<typeof createModule>>
let service: ApplyImportService

async function createModule() {
  const ref = await Test.createTestingModule({
    imports: [DbModule, ImportsModule, PortfolioModule, TradesModule],
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

const arrival = (
  quantity: string,
  when: string,
  ticker = 'BTCUSDT',
  price?: string,
): RawOperation => ({
  kind: 'arrival',
  ticker,
  ...(price ? { price } : {}),
  instrumentClass: 'crypto',
  quantity,
  currency: 'USDT',
  executedAt: when,
  externalId: `deposit-${when}`,
})

// Одинаковые части одной заявки: различаются только идентификатором.
const fill = (externalId: string): RawOperation => ({
  kind: 'trade',
  side: 'buy',
  ticker: 'TIAUSDT',
  instrumentClass: 'crypto',
  quantity: '5',
  price: '8',
  fee: '0',
  currency: 'USDT',
  executedAt: '2025-04-01T12:00:00.000Z',
  externalId,
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

// Та же сделка приезжает двумя путями: по API со своим `execId` и из выгрузки
// с ключом из содержимого. Ключ идемпотентности их не связывает, и без сверки
// по содержимому журнал задвоил бы сделку — а порядок загрузки решал бы, верны
// ли деньги. Решено 24.10.2026: сверять содержимое с учётом кратности.
it('сделка, уже приехавшая по API, не задваивается из выгрузки', async () => {
  const seed = await seedStatement()
  const bought = {
    kind: 'trade' as const,
    side: 'buy' as const,
    ticker: 'BTCUSDT',
    instrumentClass: 'crypto' as const,
    quantity: '0.01',
    price: '90000',
    fee: '0.9',
    currency: 'USDT',
    executedAt: '2025-03-01T10:00:00.000Z',
    externalId: 'exec-from-api',
  }

  await service.apply(seed.userId, seed.importId, [bought])
  // То же исполнение из выгрузки: идентификатор другой, содержимое то же.
  const again = await service.apply(seed.userId, seed.importId, [
    { ...bought, externalId: 'hash-from-statement', fee: '0.901' },
  ])

  expect(again).toMatchObject({ created: 0, skipped: 1 })
  expect(await db.prisma.trade.count({ where: { accountId: seed.accountId } })).toBe(1)
})

// Кратность: биржа дробит заявку на одинаковые исполнения в одну секунду.
// Сравнение «есть или нет» слило бы их в одну сделку, поэтому считается, сколько
// таких уже записано, и добавляется разница.
it('три одинаковых исполнения против двух записанных добавляют одно', async () => {
  const seed = await seedStatement()

  await service.apply(seed.userId, seed.importId, [fill('api-1'), fill('api-2')])
  const third = await service.apply(seed.userId, seed.importId, [
    fill('csv-1'),
    fill('csv-2'),
    fill('csv-3'),
  ])

  expect(third).toMatchObject({ created: 1, skipped: 2 })
  expect(await db.prisma.trade.count({ where: { accountId: seed.accountId } })).toBe(3)
})

// Порядок загрузки больше не имеет значения — это и было целью. Сначала
// выгрузка, потом синхронизация: результат тот же.
it('порядок загрузки не меняет результат', async () => {
  const seed = await seedStatement()
  const sold = {
    kind: 'trade' as const,
    side: 'sell' as const,
    ticker: 'ETHUSDT',
    instrumentClass: 'crypto' as const,
    quantity: '0.5',
    price: '3000',
    fee: '1.5',
    currency: 'USDT',
    executedAt: '2025-05-01T09:00:00.000Z',
    externalId: 'from-statement',
  }

  await service.apply(seed.userId, seed.importId, [
    arrival('0.5', '2025-04-20T09:00:00.000Z', 'ETHUSDT'),
    { ...sold, ticker: 'ETHUSDT' },
  ])
  const fromApi = await service.apply(seed.userId, seed.importId, [
    { ...sold, externalId: 'from-api' },
  ])

  expect(fromApi).toMatchObject({ created: 0, skipped: 1 })
  expect(await db.prisma.trade.count({ where: { accountId: seed.accountId, side: 'sell' } })).toBe(
    1,
  )
})

// Приход должен быть виден списком как отдельный вид операции: в данных это
// покупка по нулевой цене, и без пометки экран показывал бы «купил по нулю».
it('приход отдаётся списком с пометкой, а не как обычная покупка', async () => {
  const seed = await seedStatement()
  await service.apply(seed.userId, seed.importId, [arrival('0.002', '2025-07-01T10:00:00.000Z')])

  const trades = moduleRef.get(TradesService)
  const [listed] = await trades.list(seed.userId, { accountId: seed.accountId })

  expect(listed?.costUnknown).toBe(true)
  expect(Money.of(listed!.price.toString()).toString()).toBe('0')
})

// Цену прихода ставит воркер по рынку на момент зачисления: тогда лот не
// нулевой, и прибыль при продаже считается от настоящей разницы цен, а не от
// всей выручки.
it('приход с ценой даёт лот с себестоимостью, а не нулевой', async () => {
  const seed = await seedStatement()

  await service.apply(seed.userId, seed.importId, [
    arrival('0.01', '2025-08-01T10:00:00.000Z', 'BTCUSDT', '90000'),
    sale('0.01', '100000', '2025-08-15T10:00:00.000Z'),
  ])

  const lot = await db.prisma.lot.findFirstOrThrow({ where: { accountId: seed.accountId } })
  expect(Money.of(lot.costOpen.toString()).toString()).toBe('900')

  const position = await db.prisma.position.findFirstOrThrow({
    where: { accountId: seed.accountId },
  })
  // 0.01 × (100000 − 90000) = 100, а не вся выручка.
  expect(Money.of(position.realizedPnl.toString()).toString()).toBe('100')
})
