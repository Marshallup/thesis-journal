import { randomUUID } from 'node:crypto'
import { Test } from '@nestjs/testing'
import { Money } from '@thesis/contracts'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { DbModule } from '../src/db/db.module.ts'
import { PrismaService } from '../src/db/prisma.service.ts'
import { ApplyImportService } from '../src/imports/apply-import.service.ts'
import type { ImportResult } from '../src/imports/apply-import.service.ts'
import { ImportsModule } from '../src/imports/imports.module.ts'
import { TradesService } from '../src/trades/trades.service.ts'
import { RabbitPublisher } from '../src/imports/rabbit.publisher.ts'
import { sberOperations } from './fixtures/sber-operations.ts'
import type { SberFixtureOptions } from './fixtures/sber-operations.ts'
import { withTestDb } from './setup-db.ts'

let db: Awaited<ReturnType<typeof withTestDb>>
let moduleRef: Awaited<ReturnType<typeof createModule>>
let service: ApplyImportService
let tradesService: TradesService
let prisma: PrismaService

// Публикация команды в тестах подменяется: живых обращений к брокеру из тестов
// не бывает, а здесь проверяется применение операций, а не доставка.
const publisher = { send: () => {} }

async function createModule() {
  const ref = await Test.createTestingModule({ imports: [DbModule, ImportsModule] })
    .overrideProvider(RabbitPublisher)
    .useValue(publisher)
    .compile()
  await ref.init()
  return ref
}

// Сидинг владельцем: RLS его не ограничивает, а через роль приложения вставка
// счёта упиралась бы в политику, которую мы же и проверяем.
async function seedAccount(email: string) {
  const user = await db.prisma.user.create({ data: { email, passwordHash: 'x' } })
  const account = await db.prisma.account.create({
    data: { userId: user.id, provider: 'sber', kind: 'broker', baseCurrency: 'RUB' },
  })
  return { userId: user.id, accountId: account.id }
}

// Строка импорта создаётся владельцем базы: раньше её создавала заливка файла,
// а теперь файл разбирает воркер, и api получает уже операции.
async function seedImport(accountId: string): Promise<string> {
  const row = await db.prisma.import.create({
    data: { accountId, source: 'sber', fileHash: randomUUID(), status: 'uploaded' },
  })
  return row.id
}

// Было «залить файл и применить», стало «создать импорт и применить
// операции»: разбор переехал в ingestor, и api его больше не делает.
async function applyFixture(
  userId: string,
  accountId: string,
  options: SberFixtureOptions = {},
): Promise<{ importId: string; apply: () => Promise<ImportResult> }> {
  const importId = await seedImport(accountId)
  return {
    importId,
    apply: () => service.apply(userId, importId, sberOperations(options)),
  }
}

const money = (value: unknown) => Money.of(String(value)).toString()

beforeAll(async () => {
  db = await withTestDb()
  process.env.APP_DATABASE_URL = db.appUrl
  moduleRef = await createModule()
  service = moduleRef.get(ApplyImportService)
  tradesService = moduleRef.get(TradesService)
  prisma = moduleRef.get(PrismaService)
})

afterAll(async () => {
  await moduleRef.close()
  await db.stop()
})

it('повторный прогон того же импорта не задваивает сделки', async () => {
  const { userId, accountId } = await seedAccount('import@example.com')
  const { apply } = await applyFixture(userId, accountId)

  const first = await apply()
  const second = await apply()

  expect(first.created).toBeGreaterThan(0)
  expect(second.created).toBe(0)
  expect(second.skipped).toBe(first.created)

  const trades = await prisma.withUser(userId, (tx) => tx.trade.findMany({ where: { accountId } }))
  expect(trades).toHaveLength(4)
  // Продажа в фикстуре идёт последней по времени и первой по порядку строк:
  // без сортировки она не нашла бы лотов и импорт упал бы целиком.
  expect(trades.filter((trade) => trade.side === 'sell')).toHaveLength(1)
})

it('дивиденды и комиссии попадают в ledger, а не в сделки', async () => {
  const { userId, accountId } = await seedAccount('ledger@example.com')
  const { apply } = await applyFixture(userId, accountId)

  await apply()

  const ledger = await prisma.withUser(userId, (tx) =>
    tx.cashLedger.findMany({ where: { accountId }, orderBy: { occurredAt: 'asc' } }),
  )
  expect(ledger.map((entry) => entry.kind)).toEqual([
    'deposit',
    'fee',
    'dividend',
    'deposit',
    'deposit',
  ])

  // Знак несёт направление: списание отрицательное, иначе сумма ledger не
  // сойдётся с балансом в задаче 34.
  const fee = ledger.find((entry) => entry.kind === 'fee')
  expect(money(fee?.amount)).toBe('-11.28')
  expect(money(ledger.find((entry) => entry.kind === 'dividend')?.amount)).toBe('340.2')

  // Дивиденд знает свою бумагу, пополнение — нет.
  expect(ledger.find((entry) => entry.kind === 'dividend')?.instrumentId).not.toBeNull()
  expect(ledger.find((entry) => entry.kind === 'deposit')?.instrumentId).toBeNull()
})

it('лоты и позиция сходятся после импорта', async () => {
  const { userId, accountId } = await seedAccount('positions@example.com')
  const { apply } = await applyFixture(userId, accountId)

  await apply()

  const { lots, positions } = await prisma.withUser(userId, async (tx) => ({
    lots: await tx.lot.findMany({ where: { accountId } }),
    positions: await tx.position.findMany({ where: { accountId } }),
  }))

  // Куплено 10 + 5 SBER, продано 7; плюс 2 LKOH отдельным лотом.
  const remaining = lots.reduce((sum, lot) => sum.plus(money(lot.qtyRemaining)), Money.of('0'))
  const held = positions.reduce((sum, p) => sum.plus(money(p.quantity)), Money.of('0'))
  expect(remaining.toString()).toBe(held.toString())
  expect(held.toString()).toBe('10')
})

// Продажа без покупки — штатное состояние первого импорта: выгрузка Сбера
// ограничена годом. На настоящем отчёте одна такая блокировала бы 33 из 34.
it('откладывает продажу без покупок, а остальное применяет', async () => {
  const { userId, accountId } = await seedAccount('uncovered@example.com')
  const { importId, apply } = await applyFixture(userId, accountId, { uncoveredSell: true })

  const result = await apply()

  // Продажа отложена целиком, и рядом сказано, чего именно не хватило:
  // покупок GMKN в отчёте нет вовсе, поэтому не хватает всех четырёх.
  expect(result.deferred).toEqual([{ ticker: 'GMKN', quantity: '4', missing: '4' }])
  expect(result.created).toBeGreaterThan(0)

  const { trades, raw } = await prisma.withUser(userId, async (tx) => ({
    trades: await tx.trade.findMany({ where: { accountId } }),
    raw: await tx.import.findUniqueOrThrow({ where: { id: importId } }),
  }))
  // Применились все, кроме отложенной: её в журнале нет.
  expect(trades).toHaveLength(4)
  expect(trades.map((trade) => trade.externalId)).not.toContain('77006')
  expect(raw.status).toBe('parsed')
})

// Отложенное переживает ответ на запрос: экран показывает его и через час.
it('сохраняет отложенные операции и убирает их после применения', async () => {
  const { userId, accountId } = await seedAccount('pending@example.com')
  const { importId, apply } = await applyFixture(userId, accountId, { uncoveredSell: true })
  await apply()

  const stored = await service.pending(userId)
  expect(stored).toHaveLength(1)
  expect(stored[0]).toMatchObject({ externalId: '77006', side: 'sell', importId })
  expect(stored[0]?.missing.toString()).toBe('4')

  // Покупка приехала — отложенное применяется и перестаёт числиться.
  const instrument = await db.prisma.instrument.findFirstOrThrow({ where: { symbol: 'GMKN' } })
  await tradesService.apply(userId, {
    accountId,
    instrumentId: instrument.id,
    side: 'buy',
    quantity: '4',
    price: '120',
    fee: '0',
    executedAt: '2026-07-01T10:00:00Z',
  })
  await apply()

  expect(await service.pending(userId)).toEqual([])
})

// Главное свойство отложенной продажи: она не потеряна. Появилась покупка —
// повторная заливка того же файла применяет её, и ничего не задваивается.
it('применяет отложенную продажу, когда покупка появилась', async () => {
  const { userId, accountId } = await seedAccount('deferred@example.com')
  const { apply } = await applyFixture(userId, accountId, { uncoveredSell: true })
  await apply()

  // Открывающая покупка — то, что человек вводит руками или привозит отчётом
  // за прошлый год.
  const instrument = await db.prisma.instrument.findFirstOrThrow({ where: { symbol: 'GMKN' } })
  await tradesService.apply(userId, {
    accountId,
    instrumentId: instrument.id,
    side: 'buy',
    quantity: '4',
    price: '120',
    fee: '0',
    executedAt: '2026-07-01T10:00:00Z',
  })

  const again = await apply()

  expect(again.deferred).toEqual([])
  expect(again.created).toBe(1)

  const stored = await prisma.withUser(userId, (tx) =>
    tx.trade.findMany({ where: { accountId, externalId: '77006' } }),
  )
  expect(stored).toHaveLength(1)
})

// Гоночный тест живёт в import-concurrency.int.test.ts — там же, где сама
// блокировка.
