import { Test } from '@nestjs/testing'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { AccountsModule } from '../src/accounts/accounts.module.ts'
import { AccountsService, venueOf } from '../src/accounts/accounts.service.ts'
import { DbModule } from '../src/db/db.module.ts'
import { InstrumentsModule } from '../src/instruments/instruments.module.ts'
import { InstrumentsService } from '../src/instruments/instruments.service.ts'
import { TradesModule } from '../src/trades/trades.module.ts'
import { TradesService } from '../src/trades/trades.service.ts'
import { withTestDb } from './setup-db.ts'

let db: Awaited<ReturnType<typeof withTestDb>>
let moduleRef: Awaited<ReturnType<typeof createModule>>
let accounts: AccountsService
let instruments: InstrumentsService
let trades: TradesService

async function createModule() {
  const ref = await Test.createTestingModule({
    imports: [DbModule, AccountsModule, InstrumentsModule, TradesModule],
  }).compile()
  await ref.init()
  return ref
}

async function seedUser(email: string) {
  const user = await db.prisma.user.create({ data: { email, passwordHash: 'x' } })
  return { userId: user.id }
}

const manual = { provider: 'manual', baseCurrency: 'RUB', isIis: false } as const

beforeAll(async () => {
  db = await withTestDb()
  process.env.APP_DATABASE_URL = db.appUrl
  moduleRef = await createModule()
  accounts = moduleRef.get(AccountsService)
  instruments = moduleRef.get(InstrumentsService)
  trades = moduleRef.get(TradesService)
})

afterAll(async () => {
  await moduleRef.close()
  await db.stop()
})

it('позволяет завести счёт и записать в него сделку без импорта', async () => {
  const { userId } = await seedUser('manual@example.com')

  const account = await accounts.create(userId, manual)
  const instrument = await instruments.create({ symbol: 'SBER', class: 'equity', currency: 'RUB' })
  const trade = await trades.apply(userId, {
    accountId: account.id,
    instrumentId: instrument.id,
    side: 'buy',
    quantity: '1',
    price: '100',
    fee: '0',
    executedAt: '2026-10-21T10:00:00Z',
  })

  expect(trade.accountId).toBe(account.id)
})

it('не отдаёт чужой счёт в список', async () => {
  const mine = await seedUser('mine@example.com')
  const other = await seedUser('other@example.com')
  await accounts.create(other.userId, manual)

  expect(await accounts.list(mine.userId)).toHaveLength(0)
})

// Без нормализации «SBER», «sber » и «Sber» стали бы тремя инструментами, и
// сделки по одной бумаге разъехались бы по трём позициям.
it('не задваивает инструмент из-за регистра и пробелов', async () => {
  const first = await instruments.create({ symbol: 'GAZP', class: 'equity', currency: 'RUB' })
  const second = await instruments.create({ symbol: ' gazp ', class: 'equity', currency: 'RUB' })

  expect(second.id).toBe(first.id)
  expect(first.symbol).toBe('GAZP')
})

// Один тикер в разных классах — разные инструменты: уникальность по паре.
it('различает одинаковый тикер в разных классах', async () => {
  const equity = await instruments.create({ symbol: 'TEST', class: 'equity', currency: 'RUB' })
  const crypto = await instruments.create({ symbol: 'TEST', class: 'crypto', currency: 'USD' })

  expect(crypto.id).not.toBe(equity.id)
})

// Вид счёта выводит сервер, а не форма: клиент его не присылает вовсе, поэтому
// «Сбер + биржевой» невозможен как комбинация, а не запрещён проверкой.
it('выводит вид счёта из провайдера', () => {
  expect(venueOf('manual')).toBe('manual')
  expect(venueOf('sber')).toBe('broker')
  expect(venueOf('tinvest')).toBe('broker')
  expect(venueOf('bybit')).toBe('exchange')
  expect(venueOf('bitget')).toBe('exchange')
})

it('проставляет выведенный вид при создании счёта', async () => {
  const { userId } = await seedUser('venue@example.com')

  const account = await accounts.create(userId, {
    provider: 'sber',
    baseCurrency: 'RUB',
    isIis: false,
  })

  expect(account.kind).toBe('broker')
})
