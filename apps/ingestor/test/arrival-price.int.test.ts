import { randomUUID } from 'node:crypto'
import { IMPORT_PARSED_TOPIC } from '@thesis/contracts'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { BybitMarket } from '../src/connectors/bybit/market.ts'
import { ImportsService } from '../src/imports/imports.service.ts'
import { OutboxRepository } from '../src/outbox/outbox.repository.ts'
import { PrismaService } from '../src/db/prisma.service.ts'
import { statementArchive } from './fixtures/bybit-statement.ts'
import type { ExternalCall } from '../src/outbound/external-call.ts'
import type { ImportParsed } from '@thesis/contracts'
import type { RabbitConsumer } from '../src/rabbit/rabbit.consumer.ts'
import { withTestDb } from './setup-db.ts'

let db: Awaited<ReturnType<typeof withTestDb>>
let prisma: PrismaService
let imports: ImportsService

const realFetch = globalThis.fetch
const consumer = { on: () => {} } as unknown as RabbitConsumer
const calls = { run: (_provider: string, fn: () => Promise<unknown>) => fn() } as ExternalCall

// Свеча биржи: [время, открытие, максимум, минимум, закрытие, объём, оборот].
function answerWithClose(close: string): { urls: string[] } {
  const urls: string[] = []
  globalThis.fetch = vi.fn(async (url: unknown) => {
    urls.push(String(url))
    return new Response(
      JSON.stringify({
        retCode: 0,
        retMsg: 'OK',
        result: { list: [['1709000000000', '0', '0', '0', close, '0', '0']] },
      }),
      { status: 200 },
    )
  }) as unknown as typeof fetch
  return { urls }
}

function answerUnknownPair() {
  globalThis.fetch = vi.fn(
    async () =>
      new Response(
        JSON.stringify({ retCode: 10001, retMsg: 'Not supported symbols', result: {} }),
        {
          status: 200,
        },
      ),
  ) as unknown as typeof fetch
}

async function parseArchive(): Promise<ImportParsed> {
  const importId = randomUUID()
  await imports.parse({
    importId,
    accountId: randomUUID(),
    userId: randomUUID(),
    source: 'bybit-statement',
    fileHash: randomUUID(),
    payloadBase64: statementArchive().toString('base64'),
  })
  const [event] = await prisma.outboxEvent.findMany({
    where: { topic: IMPORT_PARSED_TOPIC },
    orderBy: { id: 'desc' },
    take: 1,
  })
  return event!.payload as unknown as ImportParsed
}

beforeAll(async () => {
  db = await withTestDb()
  process.env.INGESTOR_DATABASE_URL = db.url
  prisma = new PrismaService()
  await prisma.$connect()
  imports = new ImportsService(
    prisma,
    new OutboxRepository(prisma),
    new BybitMarket(calls),
    consumer,
  )
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

// Монета, пришедшая депозитом, получает цену рынка на момент зачисления. Это
// не настоящая себестоимость — та осталась там, где монету купили, — а ответ
// на вопрос «сколько заработано на этой бирже».
it('приход получает цену рынка на момент зачисления', async () => {
  const { urls } = answerWithClose('97435.5')

  const event = await parseArchive()
  const arrivals = event.operations.filter((operation) => operation.kind === 'arrival')

  expect(arrivals.every((operation) => operation.price === '97435.5')).toBe(true)
  // Свеча минутная и за ту самую минуту: секунда зачисления сама по себе
  // условна, депозит идёт в сети минутами.
  expect(urls[0]).toContain('interval=1')
  expect(urls[0]).toContain('category=spot')
})

// Биржа не знает такой пары — выдумывать цену нельзя. Остаётся ноль и пометка
// «себестоимость неизвестна»: прочерк честнее любого числа.
it('неизвестная пара оставляет приход без цены', async () => {
  answerUnknownPair()

  const event = await parseArchive()
  const arrivals = event.operations.filter((operation) => operation.kind === 'arrival')

  expect(arrivals.length).toBeGreaterThan(0)
  expect(arrivals.every((operation) => operation.price === undefined)).toBe(true)
})

// Сделкам цена не нужна: она уже есть в выгрузке, и спрашивать её у биржи
// значило бы заменять факт оценкой.
it('у сделок цена остаётся из выгрузки', async () => {
  answerWithClose('999999')

  const event = await parseArchive()
  const trades = event.operations.filter((operation) => operation.kind === 'trade')

  expect(trades.every((operation) => operation.price !== '999999')).toBe(true)
})
