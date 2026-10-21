import { Test } from '@nestjs/testing'
import { Money } from '@thesis/contracts'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { DbModule } from '../src/db/db.module.ts'
import { PrismaService } from '../src/db/prisma.service.ts'
import { ApplyImportService } from '../src/imports/apply-import.service.ts'
import { ImportsModule } from '../src/imports/imports.module.ts'
import { RawImportService } from '../src/imports/raw-import.service.ts'
import { buildSberOperationsXlsx } from './fixtures/sber-operations.ts'
import type { SberFixtureOptions } from './fixtures/sber-operations.ts'
import { withTestDb } from './setup-db.ts'

let db: Awaited<ReturnType<typeof withTestDb>>
let moduleRef: Awaited<ReturnType<typeof createModule>>
let service: ApplyImportService
let uploads: RawImportService
let prisma: PrismaService

async function createModule() {
  const ref = await Test.createTestingModule({ imports: [DbModule, ImportsModule] }).compile()
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

async function uploadFixture(userId: string, accountId: string, options: SberFixtureOptions = {}) {
  const file = await buildSberOperationsXlsx(options)
  const { importId } = await uploads.upload(userId, accountId, file, 'operations.xlsx')
  return importId
}

const money = (value: unknown) => Money.of(String(value)).toString()

beforeAll(async () => {
  db = await withTestDb()
  process.env.APP_DATABASE_URL = db.appUrl
  moduleRef = await createModule()
  service = moduleRef.get(ApplyImportService)
  uploads = moduleRef.get(RawImportService)
  prisma = moduleRef.get(PrismaService)
})

afterAll(async () => {
  await moduleRef.close()
  await db.stop()
})

it('повторный прогон того же импорта не задваивает сделки', async () => {
  const { userId, accountId } = await seedAccount('import@example.com')
  const importId = await uploadFixture(userId, accountId)

  const first = await service.run(userId, importId)
  const second = await service.run(userId, importId)

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
  const importId = await uploadFixture(userId, accountId)

  await service.run(userId, importId)

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
  const importId = await uploadFixture(userId, accountId)

  await service.run(userId, importId)

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

it('продажа без покупок останавливает импорт целиком', async () => {
  const { userId, accountId } = await seedAccount('uncovered@example.com')
  const importId = await uploadFixture(userId, accountId, { uncoveredSell: true })

  await expect(service.run(userId, importId)).rejects.toThrow(/GMKN — 4/)

  // Ничего не применилось: отчёт принимается целиком или не принимается.
  const trades = await prisma.withUser(userId, (tx) => tx.trade.findMany({ where: { accountId } }))
  expect(trades).toHaveLength(0)

  // И неудача записана в сам импорт, а не потеряна.
  const raw = await prisma.withUser(userId, (tx) =>
    tx.rawImport.findUniqueOrThrow({ where: { id: importId } }),
  )
  expect(raw.status).toBe('failed')
  expect(raw.error).toMatch(/GMKN/)
})

// Гоночный тест обязателен для всего, что двигает деньги
// (.claude/rules/tests.md). Формулировка «успешна ровно одна» тут не подходит:
// импорт идемпотентен, и обе попытки обязаны завершиться — одна создаёт,
// вторая пропускает. Проверяется, что деньги и сделки не задвоились.
//
// До правки InstrumentsService этот тест падал три раза из трёх: вторая
// попытка отваливалась на upsert инструмента. Разбор — docs/incidents.md.
it('два одновременных импорта одного отчёта не задваивают сделки', async () => {
  const { userId, accountId } = await seedAccount('race@example.com')
  const importId = await uploadFixture(userId, accountId)

  const outcomes = await Promise.allSettled([
    service.run(userId, importId),
    service.run(userId, importId),
  ])

  const created = outcomes.flatMap((outcome) =>
    outcome.status === 'fulfilled' ? [outcome.value.created] : [],
  )
  expect(created.toSorted((a, b) => a - b)).toEqual([0, 9])

  const { trades, ledger } = await prisma.withUser(userId, async (tx) => ({
    trades: await tx.trade.findMany({ where: { accountId } }),
    ledger: await tx.cashLedger.findMany({ where: { accountId } }),
  }))
  expect(trades).toHaveLength(4)
  expect(ledger).toHaveLength(5)
})
