import { createHash } from 'node:crypto'
import { Test } from '@nestjs/testing'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { AccountsModule } from '../src/accounts/accounts.module.ts'
import { AccountsService } from '../src/accounts/accounts.service.ts'
import { DbModule } from '../src/db/db.module.ts'
import { ImportsModule } from '../src/imports/imports.module.ts'
import { RawImportService } from '../src/imports/raw-import.service.ts'
import { PrismaService } from '../src/db/prisma.service.ts'
import { withTestDb } from './setup-db.ts'

let db: Awaited<ReturnType<typeof withTestDb>>
let moduleRef: Awaited<ReturnType<typeof createModule>>
let service: RawImportService
let accounts: AccountsService
let prisma: PrismaService

async function createModule() {
  const ref = await Test.createTestingModule({
    imports: [DbModule, AccountsModule, ImportsModule],
  }).compile()
  await ref.init()
  return ref
}

async function seedAccount(email: string) {
  const user = await db.prisma.user.create({ data: { email, passwordHash: 'x' } })
  const account = await accounts.create(user.id, {
    provider: 'sber',
    baseCurrency: 'RUB',
    isIis: false,
  })
  return { userId: user.id, accountId: account.id }
}

// Содержимое выдуманное и к структуре отчёта отношения не имеет: дедупликация
// идёт по хешу байтов, разбор появится в задаче 15 вместе с настоящей фикстурой.
const report = Buffer.from('отчёт за октябрь, суммы выдуманные')

beforeAll(async () => {
  db = await withTestDb()
  process.env.APP_DATABASE_URL = db.appUrl
  moduleRef = await createModule()
  service = moduleRef.get(RawImportService)
  accounts = moduleRef.get(AccountsService)
  prisma = moduleRef.get(PrismaService)
})

afterAll(async () => {
  await moduleRef.close()
  await db.stop()
})

it('второй раз тот же файл не создаёт новый импорт', async () => {
  const { userId, accountId } = await seedAccount('dedup@example.com')

  const first = await service.upload(userId, accountId, report, 'sber-report.xlsx')
  // Имя другое, содержимое то же — дедупликация идёт по содержимому.
  const second = await service.upload(userId, accountId, report, 'sber-report-copy.xlsx')

  expect(second.status).toBe('duplicate')
  expect(second.importId).toBe(first.importId)

  const all = await prisma.withUser(userId, (tx) => tx.rawImport.findMany({ where: { accountId } }))
  expect(all).toHaveLength(1)
})

it('первая заливка возвращает pending и сохраняет содержимое целиком', async () => {
  const { userId, accountId } = await seedAccount('first@example.com')

  const result = await service.upload(userId, accountId, report, 'sber-report.xlsx')

  expect(result.status).toBe('pending')
  const stored = await prisma.withUser(userId, (tx) =>
    tx.rawImport.findUniqueOrThrow({ where: { id: result.importId } }),
  )
  // Сырьё хранится байт в байт: перегон при баге в маппинге должен быть возможен.
  expect(Buffer.from(stored.payload).equals(report)).toBe(true)
  expect(stored.source).toBe('sber')
})

// Тот же файл на другом счёте — другой импорт: уникальность по паре.
it('не считает дублем тот же файл на другом счёте', async () => {
  const { userId, accountId } = await seedAccount('two-accounts@example.com')
  const other = await accounts.create(userId, {
    provider: 'tinvest',
    baseCurrency: 'RUB',
    isIis: false,
  })

  const first = await service.upload(userId, accountId, report, 'report.xlsx')
  const second = await service.upload(userId, other.id, report, 'report.xlsx')

  expect(second.status).toBe('pending')
  expect(second.importId).not.toBe(first.importId)
})

// Не гоночный тест, и назван честно: параллельные заливки через сервис
// контенции не создают (разбор — docs/unknowns.md). Проверяется ветка
// конфликта: запись появляется в обход сервиса.
it('находит запись, созданную в обход сервиса, вместо падения', async () => {
  const { userId, accountId } = await seedAccount('conflict@example.com')
  const fileHash = createHash('sha256').update(report).digest('hex')

  await db.prisma.rawImport.create({
    data: { accountId, source: 'sber', fileHash, payload: report, status: 'pending' },
  })

  const result = await service.upload(userId, accountId, report, 'report.xlsx')

  expect(result.status).toBe('duplicate')
  const all = await prisma.withUser(userId, (tx) => tx.rawImport.findMany({ where: { accountId } }))
  expect(all).toHaveLength(1)
})
