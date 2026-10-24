import { randomUUID } from 'node:crypto'
import { Test } from '@nestjs/testing'
import { Money } from '@thesis/contracts'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { DbModule } from '../src/db/db.module.ts'
import { ImportsModule } from '../src/imports/imports.module.ts'
import { ApplyImportService } from '../src/imports/apply-import.service.ts'
import { PortfolioModule } from '../src/portfolio/portfolio.module.ts'
import { TradesModule } from '../src/trades/trades.module.ts'
import { PortfolioService } from '../src/portfolio/portfolio.service.ts'
import { TradesService } from '../src/trades/trades.service.ts'
import { RabbitPublisher } from '../src/rabbit/rabbit.publisher.ts'
import { sberOperations } from './fixtures/sber-operations.ts'
import type { SberFixtureOptions } from './fixtures/sber-operations.ts'
import { withTestDb } from './setup-db.ts'

let db: Awaited<ReturnType<typeof withTestDb>>
let moduleRef: Awaited<ReturnType<typeof createModule>>
let portfolio: PortfolioService
let imports: ApplyImportService
let trades: TradesService

// Публикация команды в тестах подменяется: живых обращений к брокеру из тестов
// не бывает, а здесь проверяется применение операций, а не доставка.
const publisher = { send: () => {} }

async function createModule() {
  const ref = await Test.createTestingModule({
    imports: [DbModule, ImportsModule, PortfolioModule, TradesModule],
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
  trades = moduleRef.get(TradesService)
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
  // Полноту итога проверяют свои тесты ниже; здесь важно, что валюта одна и
  // сумма та же, что по счетам.
  expect(byCurrency).toHaveLength(1)
  expect(byCurrency[0]).toMatchObject({ currency: 'RUB', totalPnl: expected.toString() })
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

// --- Задача 24: итог по бумаге ------------------------------------------

// Закрытая позиция: оценивать нечего, и итог полон без цены. Если бы он
// требовал котировку, по проданной бумаге всегда был бы прочерк.
it('итог закрытой позиции равен реализованному плюс её комиссии', async () => {
  const { userId, accountId } = await seedAccount('total-closed@example.com')
  await importFixture(userId, accountId)
  // Докупленное продаётся целиком: остаток нулевой.
  const sber = await db.prisma.instrument.findFirstOrThrow({ where: { symbol: 'SBER' } })
  await trades.apply(userId, {
    accountId,
    instrumentId: sber.id,
    side: 'sell',
    quantity: '8',
    price: '300',
    fee: '0',
    executedAt: '2026-10-09T10:00:00.000Z',
  })

  const { rows } = await portfolio.summary(userId)
  const row = rows.find((item) => item.symbol === 'SBER')!

  expect(money(row.quantity)).toBe('0')
  expect(row.unrealizedPnl).toBeNull()
  expect(money(row.totalPnl!)).toBe(Money.of(row.realizedPnl).plus(row.fees).toString())
})

// Открытая позиция с ценой: нереализованное считается от текущей котировки, и
// оно входит в итог — иначе «итог по бумаге» отвечал бы только про проданное.
it('итог открытой позиции считается от текущей цены', async () => {
  const { userId, accountId } = await seedAccount('total-open@example.com')
  await importFixture(userId, accountId)
  const sber = await db.prisma.instrument.findFirstOrThrow({ where: { symbol: 'SBER' } })
  await db.prisma.instrumentPrice.create({
    data: {
      instrumentId: sber.id,
      source: 'moex',
      price: '300',
      quotedAt: new Date('2026-10-10T10:00:00.000Z'),
    },
  })

  const { rows } = await portfolio.summary(userId)
  const row = rows.find((item) => item.symbol === 'SBER')!

  // Остаток 8 по 300 — это 2400; затраты и есть costBasisTotal.
  expect(money(row.unrealizedPnl!)).toBe(Money.of('2400').minus(row.costBasisTotal).toString())
  expect(money(row.totalPnl!)).toBe(
    Money.of(row.realizedPnl).plus(row.unrealizedPnl!).plus(row.fees).toString(),
  )
})

// Остаток есть, цены нет — итога не существует. Ноль здесь был бы враньём:
// он читается как «ничего не заработал», а правда в том, что неизвестно.
it('остаток без цены даёт прочерк, а не ноль', async () => {
  const { userId, accountId } = await seedAccount('total-unpriced@example.com')
  await importFixture(userId, accountId)
  // Справочник и цены общие для всех пользователей, RLS на них нет: цену SBER
  // мог записать соседний тест. Убираем её, иначе проверяется не то.
  const sberId = (await db.prisma.instrument.findFirstOrThrow({ where: { symbol: 'SBER' } })).id
  await db.prisma.instrumentPrice.deleteMany({ where: { instrumentId: sberId } })

  const { rows } = await portfolio.summary(userId)
  const row = rows.find((item) => item.symbol === 'SBER')!

  expect(money(row.quantity)).not.toBe('0')
  expect(row.unrealizedPnl).toBeNull()
  expect(row.totalPnl).toBeNull()
})

// --- Задача 25: разрез по счетам ----------------------------------------

// Бумажный счёт — воображаемая торговля. В строке он есть, в итоге его быть
// не должно: иначе тренажёр подмешивается к настоящим деньгам.
it('бумажный счёт виден строкой, но в итог по валюте не входит', async () => {
  const { userId, accountId } = await seedAccount('paper@example.com')
  await importFixture(userId, accountId)

  const paper = await db.prisma.account.create({
    data: { userId, provider: 'manual', kind: 'paper', baseCurrency: 'RUB' },
  })
  // Тренажёр должен «заработать»: с нулевым итогом тест не различал бы, входит
  // бумажный счёт в сумму или нет — ноль не меняет ничего.
  const gmkn = await db.prisma.instrument.findFirstOrThrow({ where: { symbol: 'GMKN' } })
  await trades.apply(userId, {
    accountId: paper.id,
    instrumentId: gmkn.id,
    side: 'buy',
    quantity: '1',
    price: '100',
    fee: '0',
    executedAt: '2026-10-09T10:00:00.000Z',
  })
  await trades.apply(userId, {
    accountId: paper.id,
    instrumentId: gmkn.id,
    side: 'sell',
    quantity: '1',
    price: '150',
    fee: '0',
    executedAt: '2026-10-10T10:00:00.000Z',
  })

  const { accounts, byCurrency } = await portfolio.summary(userId)
  const paperRow = accounts.find((row) => row.accountId === paper.id)

  expect(paperRow).toBeDefined()
  expect(paperRow!.kind).toBe('paper')
  // Пятьдесят рублей воображаемой прибыли: именно их не должно быть в итоге.
  expect(money(paperRow!.totalPnl)).toBe('50')
  // Итог по рублям равен сумме небумажных счетов, и бумажный в него не попал.
  const real = accounts
    .filter((row) => row.kind !== 'paper')
    .reduce((sum, row) => sum.plus(row.totalPnl), Money.of('0'))
  expect(money(byCurrency.find((total) => total.currency === 'RUB')!.totalPnl)).toBe(
    real.toString(),
  )
})

// Доллар к рублю без курса не прибавить, и выдумывать его система не станет:
// итогов столько, сколько валют.
it('два счёта в разных валютах дают два итога, а не один', async () => {
  const { userId } = await seedAccount('currencies@example.com')
  // USD, а не USDT: колонка объявлена char(3) и четыре символа не принимает —
  // запись об этом в docs/unknowns.md, потому что крипто-счёт так не завести.
  await db.prisma.account.create({
    data: { userId, provider: 'bybit', kind: 'exchange', baseCurrency: 'USD' },
  })

  const { byCurrency } = await portfolio.summary(userId)

  expect(byCurrency.map((total) => total.currency).toSorted()).toEqual(['RUB', 'USD'])
})

// Счёт без сделок показывает нули, а не исчезает: пропавший счёт выглядит
// потерянным, и человек идёт искать, куда делись деньги.
it('счёт без сделок остаётся в разрезе с нулями', async () => {
  const { userId } = await seedAccount('empty-account@example.com')
  const empty = await db.prisma.account.create({
    data: { userId, provider: 'tinvest', kind: 'broker', baseCurrency: 'RUB' },
  })

  const { accounts } = await portfolio.summary(userId)
  const row = accounts.find((item) => item.accountId === empty.id)

  expect(row).toBeDefined()
  expect(money(row!.totalPnl)).toBe('0')
  expect(money(row!.realizedPnl)).toBe('0')
  expect(money(row!.unrealizedPnl)).toBe('0')
})

// Счёт, у которого цены нет ни по одной открытой позиции: нереализованное по
// нему не ноль, а неизвестно. Ноль на экране читается как «ничего не нажил»,
// и это вранье тем заметнее, чем больше позиций.
it('счёт с позициями без цены считает их и не выдаёт ноль за ответ', async () => {
  const { userId, accountId } = await seedAccount(`unpriced-account-${randomUUID()}@example.com`)
  await importFixture(userId, accountId)
  const sberId = (await db.prisma.instrument.findFirstOrThrow({ where: { symbol: 'SBER' } })).id
  await db.prisma.instrumentPrice.deleteMany({ where: { instrumentId: sberId } })

  const { accounts, byCurrency } = await portfolio.summary(userId)
  const account = accounts.find((item) => item.accountId === accountId)!

  expect(account.unpricedPositions).toBeGreaterThan(0)
  expect(money(account.unrealizedPnl)).toBe('0')
  // Валютный итог тоже помечен неполным: он посчитан без этих позиций.
  expect(byCurrency.find((total) => total.currency === 'RUB')?.incomplete).toBe(true)
})

// Как только цена появилась, счётчик обнуляется, а нереализованное считается:
// пометка должна исчезать сама, а не висеть вечно.
//
// Инструмент свой: справочник и цены общие для всех пользователей, и сосед по
// файлу не должен решать, посчитается ли здесь нереализованное.
it('с ценой счётчик пуст, а нереализованное посчитано', async () => {
  const { userId, accountId } = await seedAccount(`priced-account-${randomUUID()}@example.com`)
  const instrument = await db.prisma.instrument.create({
    data: { symbol: `PRICED${randomUUID().slice(0, 8)}`, class: 'equity', currency: 'RUB' },
  })
  await trades.apply(userId, {
    accountId,
    instrumentId: instrument.id,
    side: 'buy',
    quantity: '10',
    price: '100',
    fee: '0',
    executedAt: '2026-10-20T10:00:00.000Z',
  })
  await db.prisma.instrumentPrice.create({
    data: {
      instrumentId: instrument.id,
      source: 'moex',
      price: '120',
      quotedAt: new Date('2026-10-24T15:45:00.000Z'),
    },
  })

  const { accounts, byCurrency } = await portfolio.summary(userId)
  const account = accounts.find((item) => item.accountId === accountId)!

  expect(account.unpricedPositions).toBe(0)
  expect(money(account.unrealizedPnl)).toBe('200')
  expect(byCurrency.find((total) => total.currency === 'RUB')?.incomplete).toBe(false)
})
