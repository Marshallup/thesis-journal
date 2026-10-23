import { Money } from '@thesis/contracts'
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import { PricesService } from '../src/prices/prices.service.ts'
import { createPricesModule } from './setup-prices-module.ts'
import { moexResponse, moexResponseLater } from './fixtures/moex-marketdata.ts'
import { withTestDb } from './setup-db.ts'

let db: Awaited<ReturnType<typeof withTestDb>>
let moduleRef: Awaited<ReturnType<typeof createPricesModule>>
let prices: PricesService

const realFetch = globalThis.fetch

function answerWith(body: unknown) {
  globalThis.fetch = vi.fn(
    async () => new Response(JSON.stringify(body), { status: 200 }),
  ) as unknown as typeof fetch
}

beforeAll(async () => {
  db = await withTestDb()
  process.env.INGESTOR_DATABASE_URL = db.url
  moduleRef = await createPricesModule()
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

// Переехало из api вместе с опросом: latest() и history() остались там, а
// воркер теперь владеет собственной таблицей и проверяется по ней напрямую.
async function latestPrices(): Promise<{ instrumentId: string; price: string }[]> {
  return db.prisma.$queryRaw`
    select distinct on (instrument_id)
           instrument_id as "instrumentId", price::text
      from ingestor.instrument_prices
     order by instrument_id, quoted_at desc
  `
}

async function pricePoints(instrumentId: string): Promise<number> {
  return db.prisma.providerPrice.count({ where: { instrumentId } })
}

it('сохраняет цены только тех бумаг, что есть в справочнике', async () => {
  const sber = await seedInstrument('SBER')
  answerWith(moexResponse)

  const result = await prices.refresh()

  // В ответе три бумаги, в справочнике одна: остальные нам не нужны.
  expect(result.seen).toBe(2)
  expect(result.saved).toBe(1)
  const latest = await latestPrices()
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

  const latest = await latestPrices()
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

  const latest = await latestPrices()
  const quote = latest.find((row) => row.instrumentId === sber.id)
  expect(Money.of(quote!.price).toString()).toBe('295.1')

  // При этом сама точка не потеряна: история хранит обе.
  expect(await pricePoints(sber.id)).toBeGreaterThanOrEqual(2)
})
