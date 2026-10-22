import { randomUUID } from 'node:crypto'
import { Test } from '@nestjs/testing'
import { Money } from '@thesis/contracts'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { DbModule } from '../src/db/db.module.ts'
import { ImportsModule } from '../src/imports/imports.module.ts'
import { ApplyImportService } from '../src/imports/apply-import.service.ts'
import { PortfolioModule } from '../src/portfolio/portfolio.module.ts'
import { PortfolioService } from '../src/portfolio/portfolio.service.ts'
import { RabbitPublisher } from '../src/imports/rabbit.publisher.ts'
import { sberOperations } from './fixtures/sber-operations.ts'
import type { SberFixtureOptions } from './fixtures/sber-operations.ts'
import { withTestDb } from './setup-db.ts'

let db: Awaited<ReturnType<typeof withTestDb>>
let moduleRef: Awaited<ReturnType<typeof createModule>>
let portfolio: PortfolioService
let imports: ApplyImportService

// Публикация команды в тестах подменяется: живых обращений к брокеру из тестов
// не бывает, а здесь проверяется применение операций, а не доставка.
const publisher = { send: () => {} }

async function createModule() {
  const ref = await Test.createTestingModule({
    imports: [DbModule, ImportsModule, PortfolioModule],
  })
    .overrideProvider(RabbitPublisher)
    .useValue(publisher)
    .compile()
  await ref.init()
  return ref
}

async function seedAccount(email: string) {
  const user = await db.prisma.user.create({ data: { email, passwordHash: 'x' } })
  const account = await db.prisma.account.create({
    data: { userId: user.id, provider: 'sber', kind: 'broker', baseCurrency: 'RUB' },
  })
  return { userId: user.id, accountId: account.id }
}

const money = (value: string) => Money.of(value).toString()

beforeAll(async () => {
  db = await withTestDb()
  process.env.APP_DATABASE_URL = db.appUrl
  moduleRef = await createModule()
  portfolio = moduleRef.get(PortfolioService)
  imports = moduleRef.get(ApplyImportService)
})

afterAll(async () => {
  await moduleRef.close()
  await db.stop()
})

// Было «залить файл и применить». Разбор уехал в ingestor, поэтому импорт
// создаётся строкой, а применение получает готовые операции.
async function importFixture(
  userId: string,
  accountId: string,
  options: SberFixtureOptions = {},
): Promise<string> {
  const row = await db.prisma.import.create({
    data: { accountId, source: 'sber', fileHash: randomUUID(), status: 'uploaded' },
  })
  await imports.apply(userId, row.id, sberOperations(options))
  return row.id
}

it('складывает остатки, затраты и реализованный результат по бумагам', async () => {
  const { userId, accountId } = await seedAccount('portfolio@example.com')
  await importFixture(userId, accountId)

  const { rows, totals, accounts, byCurrency } = await portfolio.summary(userId)
  const sber = rows.find((row) => row.symbol === 'SBER')

  // Куплено 10 по 250.5 и 5 по 251, продано 7 — остаток 8.
  expect(money(sber!.quantity)).toBe('8')
  expect(sber!.averagePrice).not.toBeNull()
  expect(Number(sber!.realizedPnl)).toBeGreaterThan(0)

  // Комиссия в фикстуре одна, на 11.28, и она со знаком минус.
  expect(money(totals.fees)).toBe('-11.28')
  expect(money(totals.dividends)).toBe('340.2')
  // Итог — сумма всех составляющих, а не одна из них. Цен в этом прогоне нет,
  // поэтому нереализованное не участвует.
  const expected = Money.of(totals.realizedPnl).plus(totals.fees).plus(totals.dividends)
  expect(accounts).toHaveLength(1)
  expect(money(accounts[0]!.totalPnl)).toBe(expected.toString())
  // Счёт один и рублёвый: итог по валютам — одна строка с тем же числом.
  expect(byCurrency).toEqual([{ currency: 'RUB', totalPnl: expected.toString() }])
})

it('показывает бумагу с отложенной продажей и помечает её неполной', async () => {
  const { userId, accountId } = await seedAccount('incomplete@example.com')
  await importFixture(userId, accountId, { uncoveredSell: true })

  const { rows } = await portfolio.summary(userId)
  const gmkn = rows.find((row) => row.symbol === 'GMKN')

  // Позиции по GMKN нет вовсе — только отложенная продажа. Строка всё равно
  // обязана быть: иначе о неполноте картины узнать неоткуда.
  expect(gmkn).toBeDefined()
  expect(gmkn?.incomplete).toBe(true)
  expect(rows.filter((row) => row.symbol !== 'GMKN').every((row) => !row.incomplete)).toBe(true)
})

it('не показывает чужой портфель', async () => {
  const mine = await seedAccount('mine-portfolio@example.com')
  const other = await seedAccount('other-portfolio@example.com')
  await importFixture(other.userId, other.accountId)

  expect((await portfolio.summary(mine.userId)).rows).toEqual([])
})

// Цена приезжает отдельно от сделок, поэтому портфель обязан жить и без неё:
// бумага без котировки показывается прочерком и в стоимость не входит.
it('считает стоимость и нереализованный результат по последней цене', async () => {
  const { userId, accountId } = await seedAccount('valued@example.com')
  await importFixture(userId, accountId)

  const before = await portfolio.summary(userId)
  const sberBefore = before.rows.find((row) => row.symbol === 'SBER')
  expect(sberBefore?.price).toBeNull()
  expect(sberBefore?.value).toBeNull()
  expect(money(before.totals.value)).toBe('0')

  const sber = await db.prisma.instrument.findFirstOrThrow({ where: { symbol: 'SBER' } })
  await db.prisma.instrumentPrice.create({
    data: {
      instrumentId: sber.id,
      source: 'moex',
      price: '300',
      quotedAt: new Date('2026-10-22T08:00:00Z'),
    },
  })

  const after = await portfolio.summary(userId)
  const sberAfter = after.rows.find((row) => row.symbol === 'SBER')

  // Осталось 8 бумаг, затраты 2006.50 — значит стоимость 2400, нереализовано 393.50.
  expect(money(sberAfter!.value!)).toBe('2400')
  expect(money(sberAfter!.unrealizedPnl!)).toBe('393.5')
  expect(money(after.totals.value)).toBe('2400')
  // LKOH цены не имеет и в стоимость не попал.
  expect(after.rows.find((row) => row.symbol === 'LKOH')?.value).toBeNull()
})
