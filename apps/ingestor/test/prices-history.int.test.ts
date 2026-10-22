import { Test } from '@nestjs/testing'
import { Money } from '@thesis/contracts'
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import { DbModule } from '../src/db/db.module.ts'
import { PricesModule } from '../src/prices/prices.module.ts'
import { PricesService } from '../src/prices/prices.service.ts'
import { emptyHistory, historyPage, historyWithGaps } from './fixtures/moex-history.ts'
import { withTestDb } from './setup-db.ts'

let db: Awaited<ReturnType<typeof withTestDb>>
let moduleRef: Awaited<ReturnType<typeof createModule>>

const realFetch = globalThis.fetch

async function createModule() {
  const ref = await Test.createTestingModule({ imports: [DbModule, PricesModule] }).compile()
  await ref.init()
  return ref
}

// Каждый тест получает свой сервис: множество «уже спрошенных» бумаг живёт в
// памяти экземпляра, и общий сервис делал бы тесты зависимыми друг от друга.
function freshService(): PricesService {
  return moduleRef.get(PricesService, { strict: false })
}

// Ответы по страницам: клиент идёт по курсору, пока не выберет всё.
function answerHistory(total: number, calls: string[] = []) {
  globalThis.fetch = vi.fn(async (url: unknown) => {
    const address = String(url)
    calls.push(address)
    const start = Number(new URL(address).searchParams.get('start') ?? 0)
    return new Response(JSON.stringify(historyPage(start, total)), { status: 200 })
  }) as unknown as typeof fetch
}

function answerWith(body: unknown) {
  globalThis.fetch = vi.fn(
    async () => new Response(JSON.stringify(body), { status: 200 }),
  ) as unknown as typeof fetch
}

async function seedInstrument(symbol: string) {
  return db.prisma.instrument.create({ data: { symbol, class: 'equity', currency: 'RUB' } })
}

beforeAll(async () => {
  db = await withTestDb()
  process.env.INGESTOR_DATABASE_URL = db.url
  moduleRef = await createModule()
})

afterEach(() => {
  globalThis.fetch = realFetch
})

afterAll(async () => {
  await moduleRef.close()
  await db.stop()
})

// Страница истории — сто строк. Без склейки по курсору график теряет всё
// старше сотой точки, и это не видно: данные есть, просто меньше.
it('склеивает страницы истории по курсору', async () => {
  const instrument = await seedInstrument('SBER')
  const calls: string[] = []
  answerHistory(250, calls)

  const result = await freshService().backfill()

  expect(result.saved).toBe(250)
  // Три запроса: 0, 100, 200. Четвёртого быть не должно — курсор сказал, что
  // всё выбрано.
  expect(calls).toHaveLength(3)
  expect(calls.map((url) => new URL(url).searchParams.get('start'))).toEqual(['0', '100', '200'])

  const stored = await db.prisma.providerPrice.count({ where: { instrumentId: instrument.id } })
  expect(stored).toBe(250)
})

// Повторный прогон не должен ни падать, ни писать второй раз: ключ
// (instrument_id, source, quoted_at) один и тот же.
it('повторная подгрузка не задваивает историю', async () => {
  const instrument = await seedInstrument('LKOH')
  answerHistory(120)
  await freshService().backfill()
  const after = await db.prisma.providerPrice.count({ where: { instrumentId: instrument.id } })

  answerHistory(120)
  const second = await freshService().backfill()

  expect(second.saved).toBe(0)
  expect(await db.prisma.providerPrice.count({ where: { instrumentId: instrument.id } })).toBe(
    after,
  )
})

// Бумага без истории — не авария: на доске её может не быть вовсе. Цикл
// обязан дойти до остальных.
it('бумага без истории не ломает подгрузку остальных', async () => {
  const dead = await seedInstrument('DEAD')
  const alive = await seedInstrument('GAZP')

  const calls: string[] = []
  globalThis.fetch = vi.fn(async (url: unknown) => {
    const address = String(url)
    calls.push(address)
    const body = address.includes('DEAD') ? emptyHistory : historyPage(0, 30)
    return new Response(JSON.stringify(body), { status: 200 })
  }) as unknown as typeof fetch

  const result = await freshService().backfill()

  expect(calls.some((url) => url.includes('DEAD'))).toBe(true)
  expect(await db.prisma.providerPrice.count({ where: { instrumentId: dead.id } })).toBe(0)
  expect(await db.prisma.providerPrice.count({ where: { instrumentId: alive.id } })).toBe(30)
  expect(result.filled).toBeGreaterThan(0)
})

// Нулевая цена в истории означает «торгов не было». Записать её значит
// нарисовать на графике падение до нуля — и упереться в CHECK (price > 0).
it('строки без цены пропускаются, а не пишутся нулями', async () => {
  const instrument = await seedInstrument('GMKN')
  answerWith(historyWithGaps)

  await freshService().backfill()

  const stored = await db.prisma.providerPrice.findMany({
    where: { instrumentId: instrument.id },
    orderBy: { quotedAt: 'asc' },
  })
  expect(stored).toHaveLength(2)
  expect(stored.map((row) => Money.of(row.price.toString()).toString())).toEqual(['100.5', '101.5'])
})

// Дневная цена получает время закрытия основной сессии: полночь на бирже не
// существует, и точка в полночь — это выдумка.
it('дневная цена записана временем закрытия, 18:45 по Москве', async () => {
  const instrument = await seedInstrument('MGNT')
  answerWith(historyPage(0, 1))

  await freshService().backfill()

  const point = await db.prisma.providerPrice.findFirstOrThrow({
    where: { instrumentId: instrument.id },
  })
  // 18:45 MSK — это 15:45 UTC.
  expect(point.quotedAt.toISOString()).toBe('2021-01-04T15:45:00.000Z')
})
