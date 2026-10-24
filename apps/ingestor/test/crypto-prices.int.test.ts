import { randomUUID } from 'node:crypto'
import { PRICES_TOPIC } from '@thesis/contracts'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { BybitMarket } from '../src/connectors/bybit/market.ts'
import { CryptoPricesService } from '../src/prices/crypto.service.ts'
import { OutboxRepository } from '../src/outbox/outbox.repository.ts'
import { PrismaService } from '../src/db/prisma.service.ts'
import type { ExternalCall } from '../src/outbound/external-call.ts'
import type { PriceQuoted } from '@thesis/contracts'
import { withTestDb } from './setup-db.ts'

let db: Awaited<ReturnType<typeof withTestDb>>
let prisma: PrismaService

const realFetch = globalThis.fetch
const calls = { run: (_provider: string, fn: () => Promise<unknown>) => fn() } as ExternalCall

// Свой экземпляр на тест: множество «уже спрошенных» пар живёт в памяти
// сервиса, и общий делал бы тесты зависимыми друг от друга.
function freshService(): CryptoPricesService {
  return new CryptoPricesService(prisma, new BybitMarket(calls), new OutboxRepository(prisma))
}

function answer(body: (url: string) => unknown): { urls: string[] } {
  const urls: string[] = []
  globalThis.fetch = vi.fn(async (url: unknown) => {
    urls.push(String(url))
    return new Response(JSON.stringify(body(String(url))), { status: 200 })
  }) as unknown as typeof fetch
  return { urls }
}

function tickers(prices: Record<string, string>) {
  return {
    retCode: 0,
    retMsg: 'OK',
    result: { list: Object.entries(prices).map(([symbol, lastPrice]) => ({ symbol, lastPrice })) },
  }
}

// Свеча: [время, открытие, максимум, минимум, закрытие, объём, оборот].
function klines(days: number, close: string) {
  const start = Date.UTC(2026, 0, 1)
  return {
    retCode: 0,
    retMsg: 'OK',
    result: {
      list: Array.from({ length: days }, (_, i) => [
        String(start + i * 86_400_000),
        '0',
        '0',
        '0',
        close,
        '0',
        '0',
      ]).toReversed(),
    },
  }
}

async function seedPair(symbol: string) {
  return db.prisma.instrument.create({ data: { symbol, class: 'crypto', currency: 'USDT' } })
}

async function published(): Promise<PriceQuoted[]> {
  const events = await prisma.outboxEvent.findMany({
    where: { topic: PRICES_TOPIC },
    orderBy: { id: 'asc' },
  })
  return events.map((event) => event.payload as unknown as PriceQuoted)
}

beforeAll(async () => {
  db = await withTestDb()
  process.env.INGESTOR_DATABASE_URL = db.url
  prisma = new PrismaService()
  await prisma.$connect()
})

beforeEach(async () => {
  await prisma.outboxEvent.deleteMany()
})

afterEach(() => {
  globalThis.fetch = realFetch
})

afterAll(async () => {
  await prisma.$disconnect()
  await db.stop()
})

// Вся доска одним запросом: перечислять свои пары значило бы делать двадцать
// запросов там, где биржа отдаёт всё разом.
it('текущие цены берутся одним запросом на всю доску', async () => {
  const pair = await seedPair(`AAA${randomUUID().slice(0, 4)}USDT`)
  const { urls } = answer(() => tickers({ [pair.symbol]: '12.34', BTCUSDT: '80000' }))

  const result = await freshService().refresh()

  expect(result.saved).toBe(1)
  expect(urls).toHaveLength(1)
  expect(urls[0]).toContain('/v5/market/tickers')
  // Чужие пары не записываются: справочник отвечает, какие цены нам нужны.
  const stored = await prisma.providerPrice.findMany({ where: { instrumentId: pair.id } })
  expect(stored).toHaveLength(1)
})

// Цена без события осталась бы невидимой: проекция в api строится событиями.
it('каждая записанная цена уезжает событием с ключом-тикером', async () => {
  const pair = await seedPair(`BBB${randomUUID().slice(0, 4)}USDT`)
  answer(() => tickers({ [pair.symbol]: '7.5' }))

  await freshService().refresh()

  const events = await published()
  expect(events).toMatchObject([{ symbol: pair.symbol, source: 'bybit', price: '7.5' }])
})

// История нужна не для красоты графика: без неё нельзя посчитать стоимость
// портфеля на дату и результат за год.
it('история дневных закрытий сохраняется по дням', async () => {
  const pair = await seedPair(`CCC${randomUUID().slice(0, 4)}USDT`)
  answer((url) => (url.includes('kline') ? klines(3, '42') : tickers({})))

  await freshService().backfill()

  // Проверяется своя пара: справочник инструментов общий для всех тестов
  // файла, и соседние пары подгружаются тем же проходом.
  const stored = await prisma.providerPrice.findMany({
    where: { instrumentId: pair.id },
    orderBy: { quotedAt: 'asc' },
  })
  expect(stored).toHaveLength(3)
  // Дневная цена относится к концу дня, а не к полуночи, с которой свеча
  // открывается: иначе на графике она встанет на сутки раньше.
  expect(stored[0]?.quotedAt.toISOString()).toBe('2026-01-01T23:59:59.000Z')
})

// Делистнутая пара — не авария: цикл обязан дойти до остальных, а тратить на
// неё лимит каждый раз незачем.
it('пара без истории не ломает остальные и не спрашивается дважды', async () => {
  const dead = await seedPair(`DEAD${randomUUID().slice(0, 4)}USDT`)
  const alive = await seedPair(`LIVE${randomUUID().slice(0, 4)}USDT`)
  const { urls } = answer((url) =>
    url.includes(dead.symbol)
      ? { retCode: 10001, retMsg: 'Not supported symbols', result: {} }
      : klines(2, '5'),
  )

  const service = freshService()
  await service.backfill()
  const asked = urls.length
  await service.backfill()

  expect(await prisma.providerPrice.count({ where: { instrumentId: dead.id } })).toBe(0)
  expect(await prisma.providerPrice.count({ where: { instrumentId: alive.id } })).toBe(2)
  // Второй проход не спрашивает ничего: обе пары уже пробовали.
  expect(urls).toHaveLength(asked)
})

// Повторный прогон не задваивает: ключ (инструмент, источник, время) тот же.
it('повторная подгрузка истории ничего не добавляет', async () => {
  const pair = await seedPair(`EEE${randomUUID().slice(0, 4)}USDT`)
  answer((url) => (url.includes('kline') ? klines(2, '9') : tickers({})))

  await freshService().backfill()
  const second = await freshService().backfill()

  expect(second.saved).toBe(0)
  expect(await prisma.providerPrice.count({ where: { instrumentId: pair.id } })).toBe(2)
})
