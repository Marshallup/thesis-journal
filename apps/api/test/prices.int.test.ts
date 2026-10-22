import { Test } from '@nestjs/testing'
import { Money } from '@thesis/contracts'
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import { DbModule } from '../src/db/db.module.ts'
import { PricesModule } from '../src/prices/prices.module.ts'
import { PricesService } from '../src/prices/prices.service.ts'
import { moexResponse, moexResponseLater } from './fixtures/moex-marketdata.ts'
import { withTestDb } from './setup-db.ts'

let db: Awaited<ReturnType<typeof withTestDb>>
let moduleRef: Awaited<ReturnType<typeof createModule>>
let prices: PricesService

const realFetch = globalThis.fetch

async function createModule() {
  const ref = await Test.createTestingModule({ imports: [DbModule, PricesModule] }).compile()
  await ref.init()
  return ref
}

function answerWith(body: unknown) {
  globalThis.fetch = vi.fn(
    async () => new Response(JSON.stringify(body), { status: 200 }),
  ) as unknown as typeof fetch
}

beforeAll(async () => {
  db = await withTestDb()
  process.env.APP_DATABASE_URL = db.appUrl
  moduleRef = await createModule()
  prices = moduleRef.get(PricesService)
})

afterEach(() => {
  globalThis.fetch = realFetch
})

afterAll(async () => {
  await moduleRef.close()
  await db.stop()
})

async function seedInstrument(symbol: string) {
  return db.prisma.instrument.create({ data: { symbol, class: 'equity', currency: 'RUB' } })
}

it('сохраняет цены только тех бумаг, что есть в справочнике', async () => {
  const sber = await seedInstrument('SBER')
  answerWith(moexResponse)

  const result = await prices.refresh()

  // В ответе три бумаги, в справочнике одна: остальные нам не нужны.
  expect(result.seen).toBe(2)
  expect(result.saved).toBe(1)
  const latest = await prices.latest()
  expect(latest).toHaveLength(1)
  expect(latest[0]?.instrumentId).toBe(sber.id)
  expect(Money.of(latest[0]!.price).toString()).toBe('291.68')
})

// Бумага без LAST берёт следующую колонку: иначе портфель остался бы без цены
// из-за того, что сегодня по ней не торговали.
it('берёт MARKETPRICE, когда сделок не было', async () => {
  const lkoh = await seedInstrument('LKOH')
  answerWith(moexResponse)

  await prices.refresh()

  const latest = await prices.latest()
  const quote = latest.find((row) => row.instrumentId === lkoh.id)
  expect(Money.of(quote!.price).toString()).toBe('7301.5')
})

// Вне торгов ISS отдаёт ту же точку. Повторный прогон не должен ни падать,
// ни задваивать историю — торговый календарь поэтому и не нужен.
it('повторный прогон не задваивает точку', async () => {
  answerWith(moexResponse)
  await prices.refresh()
  const second = await prices.refresh()

  expect(second.saved).toBe(0)
})

it('опоздавшая точка не затирает свежую', async () => {
  const sber = await db.prisma.instrument.findFirstOrThrow({ where: { symbol: 'SBER' } })
  answerWith(moexResponseLater)
  await prices.refresh()

  // Прилетела запись, которая старше уже сохранённой.
  answerWith(moexResponse)
  await prices.refresh()

  const latest = await prices.latest()
  const quote = latest.find((row) => row.instrumentId === sber.id)
  expect(Money.of(quote!.price).toString()).toBe('295.1')

  // При этом сама точка не потеряна: история хранит обе.
  const history = await prices.history(sber.id, new Date('2026-01-01'))
  expect(history.length).toBeGreaterThanOrEqual(2)
})
