import { randomUUID } from 'node:crypto'
import { Test } from '@nestjs/testing'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { DbModule } from '../src/db/db.module.ts'
import { PrismaService } from '../src/db/prisma.service.ts'
import { ApplyImportService } from '../src/imports/apply-import.service.ts'
import { ImportsModule } from '../src/imports/imports.module.ts'
import { RabbitPublisher } from '../src/imports/rabbit.publisher.ts'
import { sberOperations } from './fixtures/sber-operations.ts'
import { withTestDb } from './setup-db.ts'

let db: Awaited<ReturnType<typeof withTestDb>>
let moduleRef: Awaited<ReturnType<typeof createModule>>
let service: ApplyImportService
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

async function seedAccount(email: string) {
  const user = await db.prisma.user.create({ data: { email, passwordHash: 'x' } })
  const account = await db.prisma.account.create({
    data: { userId: user.id, provider: 'sber', kind: 'broker', baseCurrency: 'RUB' },
  })
  return { userId: user.id, accountId: account.id }
}

// Импорт создаётся прямо в базе: заливка файла теперь только отправляет
// команду воркеру, а проверяется здесь гонка двух применений.
async function seedImport(accountId: string): Promise<string> {
  const row = await db.prisma.import.create({
    data: { accountId, source: 'sber', fileHash: randomUUID(), status: 'uploaded' },
  })
  return row.id
}

beforeAll(async () => {
  db = await withTestDb()
  process.env.APP_DATABASE_URL = db.appUrl
  moduleRef = await createModule()
  service = moduleRef.get(ApplyImportService)
  prisma = moduleRef.get(PrismaService)
})

afterAll(async () => {
  await moduleRef.close()
  await db.stop()
})

// Замер показал: транзакции двух импортов пересекаются около 14 мс — контенция
// настоящая. В задаче 14 её не было: там транзакция была из одной вставки.
it('при двух одновременных импортах работает ровно один', async () => {
  const { userId, accountId } = await seedAccount('concurrent@example.com')
  const importId = await seedImport(accountId)

  const outcomes = await Promise.allSettled([
    service.apply(userId, importId, sberOperations()),
    service.apply(userId, importId, sberOperations()),
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
    raw: await tx.import.findUniqueOrThrow({ where: { id: importId } }),
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
  const importId = await seedImport(accountId)

  const first = await service.apply(userId, importId, sberOperations())
  const second = await service.apply(userId, importId, sberOperations())

  expect(first.created).toBeGreaterThan(0)
  expect(second.created).toBe(0)
})

// Ключ блокировки — счёт, а не импорт: два разных отчёта по одному счёту
// пересекаются по лотам и позициям так же, как один отчёт сам с собой.
it('второй отчёт по тому же счёту тоже получает отказ', async () => {
  const { userId, accountId } = await seedAccount('two-reports@example.com')
  const first = await seedImport(accountId)
  const second = await seedImport(accountId)
  expect(second).not.toBe(first)

  const outcomes = await Promise.allSettled([
    service.apply(userId, first, sberOperations()),
    // Второй отчёт того же счёта: иной по содержимому, такой же валидный.
    service.apply(userId, second, sberOperations({ extraDeposit: true })),
  ])

  expect(outcomes.map((outcome) => outcome.status).toSorted()).toEqual(['fulfilled', 'rejected'])
})

// Без гонки и без тайминга: блокировку держит сторонняя транзакция, поэтому
// отказ гарантирован, и видно, что проигравший не трогает сам импорт.
it('проигравший не помечает импорт неудачным', async () => {
  const { userId, accountId } = await seedAccount('untouched@example.com')
  const importId = await seedImport(accountId)

  await db.prisma.$transaction(async (holder) => {
    // Та же функция, что в сервисе: блокирующая вернула бы `void`, который
    // Prisma не десериализует.
    const [taken] = await holder.$queryRaw<{ locked: boolean }[]>`
      select pg_try_advisory_xact_lock(hashtext(${`import:${accountId}`})) as locked
    `
    expect(taken?.locked).toBe(true)

    await expect(service.apply(userId, importId, sberOperations())).rejects.toMatchObject({
      status: 409,
    })
  })

  const raw = await prisma.withUser(userId, (tx) =>
    tx.import.findUniqueOrThrow({ where: { id: importId } }),
  )
  expect(raw.status).toBe('uploaded')
  expect(raw.error).toBeNull()
})
