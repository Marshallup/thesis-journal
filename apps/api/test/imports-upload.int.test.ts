import { createHash } from 'node:crypto'
import { Test } from '@nestjs/testing'
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest'
import { AccountsModule } from '../src/accounts/accounts.module.ts'
import { AccountsService } from '../src/accounts/accounts.service.ts'
import { DbModule } from '../src/db/db.module.ts'
import { ImportsModule } from '../src/imports/imports.module.ts'
import { ImportsService } from '../src/imports/imports.service.ts'
import { PrismaService } from '../src/db/prisma.service.ts'
import { RabbitPublisher } from '../src/rabbit/rabbit.publisher.ts'
import type { ImportParse } from '@thesis/contracts'
import { withTestDb } from './setup-db.ts'

let db: Awaited<ReturnType<typeof withTestDb>>
let moduleRef: Awaited<ReturnType<typeof createModule>>
let service: ImportsService
let accounts: AccountsService
let prisma: PrismaService

// Издатель подменён и запоминает команды: живых обращений к брокеру из тестов
// не бывает, а проверять надо именно то, что команда ушла и с чем.
const sent: ImportParse[] = []
const publisher = {
  send: (_queue: string, command: unknown) => {
    sent.push(command as ImportParse)
  },
}

async function createModule() {
  const ref = await Test.createTestingModule({
    imports: [DbModule, AccountsModule, ImportsModule],
  })
    .overrideProvider(RabbitPublisher)
    .useValue(publisher)
    .compile()
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
// идёт по хешу байтов, а разбирает файл воркер — api его не читает вовсе.
const report = Buffer.from('отчёт за октябрь, суммы выдуманные')

beforeAll(async () => {
  db = await withTestDb()
  process.env.APP_DATABASE_URL = db.appUrl
  moduleRef = await createModule()
  service = moduleRef.get(ImportsService)
  accounts = moduleRef.get(AccountsService)
  prisma = moduleRef.get(PrismaService)
})

beforeEach(() => {
  sent.length = 0
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

  const all = await prisma.withUser(userId, (tx) => tx.import.findMany({ where: { accountId } }))
  expect(all).toHaveLength(1)
  // И команда ушла один раз: повторная заливка не заставляет воркера
  // разбирать тот же файл второй раз.
  expect(sent).toHaveLength(1)
})

it('первая заливка возвращает uploaded и отдаёт воркеру файл целиком', async () => {
  const { userId, accountId } = await seedAccount('first@example.com')

  const result = await service.upload(userId, accountId, report, 'sber-report.xlsx')

  expect(result.status).toBe('uploaded')
  const stored = await prisma.withUser(userId, (tx) =>
    tx.import.findUniqueOrThrow({ where: { id: result.importId } }),
  )
  expect(stored.source).toBe('sber')
  expect(stored.status).toBe('uploaded')

  // Байты уезжают в команде, и байт в байт: перегон при баге в маппинге
  // должен быть возможен, а значит сырьё не должно портиться по дороге.
  const command = sent[0]
  expect(command?.importId).toBe(result.importId)
  expect(command?.userId).toBe(userId)
  expect(command?.fileHash).toBe(createHash('sha256').update(report).digest('hex'))
  expect(Buffer.from(command?.payloadBase64 ?? '', 'base64').equals(report)).toBe(true)
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

  expect(second.status).toBe('uploaded')
  expect(second.importId).not.toBe(first.importId)
})

// Не гоночный тест, и назван честно: параллельные заливки через сервис
// контенции не создают (разбор — docs/unknowns.md). Проверяется ветка
// конфликта: запись появляется в обход сервиса.
it('находит запись, созданную в обход сервиса, вместо падения', async () => {
  const { userId, accountId } = await seedAccount('conflict@example.com')
  const fileHash = createHash('sha256').update(report).digest('hex')

  await db.prisma.import.create({
    data: { accountId, source: 'sber', fileHash, status: 'uploaded' },
  })

  const result = await service.upload(userId, accountId, report, 'report.xlsx')

  expect(result.status).toBe('duplicate')
  const all = await prisma.withUser(userId, (tx) => tx.import.findMany({ where: { accountId } }))
  expect(all).toHaveLength(1)
  // Команды нет: разбирать нечего, импорт уже существует.
  expect(sent).toHaveLength(0)
})

// Повторный разбор не требует файла: сырьё у воркера, и команда едет без него.
it('повторный разбор отправляет команду без байтов', async () => {
  const { userId, accountId } = await seedAccount('reparse@example.com')
  const { importId } = await service.upload(userId, accountId, report, 'report.xlsx')
  sent.length = 0

  const status = await service.reparse(userId, importId)

  expect(status.status).toBe('uploaded')
  expect(sent).toHaveLength(1)
  expect(sent[0]?.payloadBase64).toBeUndefined()
  expect(sent[0]?.importId).toBe(importId)
})
