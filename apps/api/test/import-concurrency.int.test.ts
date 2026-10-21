import { Test } from '@nestjs/testing'
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

// Замер перед задачей показал, что транзакции двух параллельных импортов
// открываются с разницей в миллисекунду и пересекаются около 14 мс: контенция
// настоящая, и тест на ней держится. В задаче 14 её не было потому, что там
// транзакция состояла из одной вставки.
it('при двух одновременных импортах работает ровно один', async () => {
  const { userId, accountId } = await seedAccount('concurrent@example.com')
  const importId = await uploadFixture(userId, accountId)

  const outcomes = await Promise.allSettled([
    service.run(userId, importId),
    service.run(userId, importId),
  ])

  expect(outcomes.map((outcome) => outcome.status).toSorted()).toEqual(['fulfilled', 'rejected'])

  // Проигравший не ждёт и не делает работу повторно: 409 сразу.
  const rejection = outcomes.find((outcome) => outcome.status === 'rejected')
  expect((rejection as PromiseRejectedResult | undefined)?.reason).toMatchObject({
    status: 409,
    response: { status: 'already_running' },
  })

  // Результат победителя цел: ни задвоенных сделок, ни задвоенных денег.
  const { trades, ledger, raw } = await prisma.withUser(userId, async (tx) => ({
    trades: await tx.trade.findMany({ where: { accountId } }),
    ledger: await tx.cashLedger.findMany({ where: { accountId } }),
    raw: await tx.rawImport.findUniqueOrThrow({ where: { id: importId } }),
  }))
  expect(new Set(trades.map((trade) => trade.externalId)).size).toBe(trades.length)
  expect(trades).toHaveLength(4)
  expect(ledger).toHaveLength(5)

  // Статус ставит победитель. Проигравший не трогает импорт вообще: он не
  // сделал работы, и помечать её неудачной нечем.
  expect(raw.status).toBe('parsed')
  expect(raw.error).toBeNull()
})

// Последовательный повтор — не гонка, и отказа в нём быть не должно:
// блокировка транзакционная и снимается на коммите.
it('последовательный повторный импорт по-прежнему проходит', async () => {
  const { userId, accountId } = await seedAccount('sequential@example.com')
  const importId = await uploadFixture(userId, accountId)

  const first = await service.run(userId, importId)
  const second = await service.run(userId, importId)

  expect(first.created).toBeGreaterThan(0)
  expect(second.created).toBe(0)
})

// Ключ блокировки — счёт, а не импорт: два разных отчёта по одному счёту
// пересекаются по лотам и позициям так же, как один отчёт сам с собой.
it('второй отчёт по тому же счёту тоже получает отказ', async () => {
  const { userId, accountId } = await seedAccount('two-reports@example.com')
  const first = await uploadFixture(userId, accountId)
  const second = await uploadFixture(userId, accountId, { extraDeposit: true })
  expect(second).not.toBe(first)

  const outcomes = await Promise.allSettled([
    service.run(userId, first),
    service.run(userId, second),
  ])

  expect(outcomes.map((outcome) => outcome.status).toSorted()).toEqual(['fulfilled', 'rejected'])
})

// Без гонки и без тайминга: блокировку держит сторонняя транзакция, поэтому
// отказ гарантирован, и видно, что проигравший не трогает сам импорт.
it('проигравший не помечает импорт неудачным', async () => {
  const { userId, accountId } = await seedAccount('untouched@example.com')
  const importId = await uploadFixture(userId, accountId)

  await db.prisma.$transaction(async (holder) => {
    // Блокирующий вариант вернул бы `void`, который Prisma не умеет
    // десериализовать (`Failed to deserialize column of type 'void'`).
    // Поэтому та же функция, что в сервисе: она отдаёт boolean, и здесь он
    // обязан быть true — блокировку никто не держит.
    const [taken] = await holder.$queryRaw<{ locked: boolean }[]>`
      select pg_try_advisory_xact_lock(hashtext(${`import:${accountId}`})) as locked
    `
    expect(taken?.locked).toBe(true)

    await expect(service.run(userId, importId)).rejects.toMatchObject({ status: 409 })
  })

  const raw = await prisma.withUser(userId, (tx) =>
    tx.rawImport.findUniqueOrThrow({ where: { id: importId } }),
  )
  expect(raw.status).toBe('pending')
  expect(raw.error).toBeNull()
})
