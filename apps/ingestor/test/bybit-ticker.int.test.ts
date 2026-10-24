import { randomUUID } from 'node:crypto'
import { PRICES_TOPIC } from '@thesis/contracts'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { BybitMarket } from '../src/connectors/bybit/market.ts'
import { BybitTickerService } from '../src/connectors/bybit/ticker.service.ts'
import { BybitWsClient } from '../src/connectors/bybit/ws-client.ts'
import type { SocketLike, Tick } from '../src/connectors/bybit/ws-client.ts'
import { CbrClient } from '../src/prices/cbr.client.ts'
import { CryptoPricesService } from '../src/prices/crypto.service.ts'
import { OutboxRepository } from '../src/outbox/outbox.repository.ts'
import { PrismaService } from '../src/db/prisma.service.ts'
import type { ExternalCall } from '../src/outbound/external-call.ts'
import { withTestDb } from './setup-db.ts'

let db: Awaited<ReturnType<typeof withTestDb>>
let prisma: PrismaService

const calls = { run: (_provider: string, fn: () => Promise<unknown>) => fn() } as ExternalCall

// Биржевого сокета в тестах нет: правило проекта — живых внешних вызовов из
// тестов не бывает. Подделка умеет то же, что настоящий, плюс то, чего он не
// умеет: оборваться по команде.
class FakeSocket implements SocketLike {
  readonly sent: string[] = []
  closed = false
  private readonly listeners = new Map<string, ((event: { data?: unknown }) => void)[]>()

  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void {
    const existing = this.listeners.get(type) ?? []
    existing.push(listener)
    this.listeners.set(type, existing)
  }

  send(data: string): void {
    this.sent.push(data)
  }

  close(): void {
    this.closed = true
    this.emit('close')
  }

  // То, что биржа считает нашими подписками.
  get subscriptions(): string[] {
    return this.sent.flatMap((raw) => {
      const message = JSON.parse(raw) as { op: string; args?: string[] }
      return message.op === 'subscribe' ? (message.args ?? []) : []
    })
  }

  open(): void {
    this.emit('open')
  }

  // Разрыв: биржа закрыла соединение, а приложение об этом не просило.
  drop(): void {
    this.emit('close')
  }

  message(payload: unknown): void {
    this.emit('message', { data: JSON.stringify(payload) })
  }

  tick(symbol: string, lastPrice: string, at: Date): void {
    this.message({
      topic: `tickers.${symbol}`,
      ts: at.getTime(),
      type: 'snapshot',
      data: { symbol, lastPrice },
    })
  }

  private emit(type: string, event: { data?: unknown } = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }
}

// Сокеты, которые создал клиент, по порядку: после разрыва появляется новый, и
// проверять надо именно его подписки.
function sockets(): { all: FakeSocket[]; connect: (url: string) => SocketLike } {
  const all: FakeSocket[] = []
  return {
    all,
    connect: () => {
      const socket = new FakeSocket()
      all.push(socket)
      return socket
    },
  }
}

function freshService(client: BybitWsClient): {
  service: BybitTickerService
  prices: CryptoPricesService
} {
  const prices = new CryptoPricesService(
    prisma,
    new BybitMarket(calls),
    new CbrClient(calls),
    new OutboxRepository(prisma),
  )
  return { service: new BybitTickerService(prisma, client, prices), prices }
}

async function seedPair(symbol: string) {
  return db.prisma.instrument.create({ data: { symbol, class: 'crypto', currency: 'USDT' } })
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
  vi.useRealTimers()
})

afterAll(async () => {
  await prisma.$disconnect()
  await db.stop()
})

// Главное в задаче: поток биржи отдаёт цену десять раз в секунду, а дневник
// решений — не торговый терминал. Без окна outbox и Kafka получают поток,
// человеку не нужный, и он стоит гигабайтов.
it('сто тиков в одном окне превращаются в одну запись', async () => {
  const pair = await seedPair(`WS${randomUUID().slice(0, 6)}USDT`)
  const { service, prices } = freshService(new BybitWsClient(sockets().connect))
  await service.sync()
  // Запись должна не состояться вовсе, а не отбиться ключом в базе: ключ
  // спасает от дубля, но транзакция и поход в базу всё равно случаются.
  const save = vi.spyOn(prices, 'save')

  const start = new Date('2026-10-24T12:00:00.000Z')
  for (let i = 0; i < 100; i += 1) {
    // Сто тиков за десять секунд: все в одном пятнадцатисекундном окне.
    await service.onTick({
      symbol: pair.symbol,
      price: String(64000 + i),
      at: new Date(start.getTime() + i * 100),
    })
  }

  const stored = await prisma.providerPrice.findMany({ where: { instrumentId: pair.id } })
  expect(stored).toHaveLength(1)
  // Записана первая цена окна, а не последняя: вторую мы просто не смотрели.
  expect(stored[0]?.price.toString()).toBe('64000')
  // Время — начало окна, а не момент тика: иначе в проекции будет видимость
  // точности, которой нет.
  expect(stored[0]?.quotedAt.toISOString()).toBe('2026-10-24T12:00:00.000Z')
  expect(await prisma.outboxEvent.count({ where: { topic: PRICES_TOPIC } })).toBe(1)
  expect(save).toHaveBeenCalledTimes(1)
})

// Окно — это не «одна цена навсегда»: следующее окно даёт следующую цену.
it('новое окно даёт новую запись', async () => {
  const pair = await seedPair(`WS${randomUUID().slice(0, 6)}USDT`)
  const { service } = freshService(new BybitWsClient(sockets().connect))
  await service.sync()

  await service.onTick({ symbol: pair.symbol, price: '10', at: new Date('2026-10-24T12:00:00Z') })
  await service.onTick({ symbol: pair.symbol, price: '11', at: new Date('2026-10-24T12:00:16Z') })

  const stored = await prisma.providerPrice.findMany({
    where: { instrumentId: pair.id },
    orderBy: { quotedAt: 'asc' },
  })
  expect(stored.map((row) => row.price.toString())).toEqual(['10', '11'])
})

// Справочник отвечает на вопрос «какие цены нам нужны»: он заполняется фактом
// сделки. Поток отдаёт тысячу пар, и записывать их все значило бы хранить
// цены монет, которых мы никогда не покупали.
it('тик по чужой паре не пишется', async () => {
  const { service } = freshService(new BybitWsClient(sockets().connect))
  await service.sync()

  const saved = await service.onTick({
    symbol: 'NOTOURSUSDT',
    price: '5',
    at: new Date('2026-10-24T12:00:00Z'),
  })

  expect(saved).toBe(0)
})

// Разбор сообщения биржи: тик — это `data.lastPrice`, время — `ts`. Мусор и
// нулевая цена не тик, а повод промолчать.
it('из сообщения биржи берётся цена и её время', () => {
  const fake = sockets()
  const client = new BybitWsClient(fake.connect)
  const ticks: Tick[] = []
  client.onTick((tick) => {
    ticks.push(tick)
  })
  client.subscribe(['BTCUSDT'])
  const socket = fake.all[0]!
  socket.open()

  socket.tick('BTCUSDT', '64000.5', new Date('2026-10-24T12:00:00.000Z'))
  // Ответ на подписку, нулевая цена и чужая тема — не тики.
  socket.message({ op: 'subscribe', success: true })
  socket.tick('BTCUSDT', '0', new Date('2026-10-24T12:00:01.000Z'))
  socket.message({ topic: 'orderbook.1.BTCUSDT', data: { s: 'BTCUSDT' } })

  expect(ticks).toEqual([
    { symbol: 'BTCUSDT', price: '64000.5', at: new Date('2026-10-24T12:00:00.000Z') },
  ])
})

// Разрыв соединения на бирже — норма, а не авария. Если после него подписки
// не восстановить, поток цен молча замолкает: соединение есть, тиков нет.
it('после разрыва подписка восстанавливается', () => {
  vi.useFakeTimers()
  const fake = sockets()
  const client = new BybitWsClient(fake.connect)
  client.subscribe(['BTCUSDT', 'ETHUSDT'])
  fake.all[0]!.open()

  fake.all[0]!.drop()
  // Пауза перед первой попыткой — секунда: биржа могла закрыть соединение на
  // обслуживании, и долбить её сразу незачем.
  vi.advanceTimersByTime(1000)
  fake.all[1]!.open()

  expect(fake.all).toHaveLength(2)
  expect(fake.all[1]!.subscriptions).toEqual(['tickers.BTCUSDT', 'tickers.ETHUSDT'])
})

// Биржа закрывает молчащее соединение сама: без ping поток умирает через
// несколько минут, и выглядит это как «цены просто перестали приходить».
it('пока соединение живо, ping уходит сам', () => {
  vi.useFakeTimers()
  const fake = sockets()
  const client = new BybitWsClient(fake.connect)
  client.subscribe(['BTCUSDT'])
  const socket = fake.all[0]!
  socket.open()
  const afterSubscribe = socket.sent.length

  vi.advanceTimersByTime(60_000)

  const pings = socket.sent
    .slice(afterSubscribe)
    .filter((raw) => (JSON.parse(raw) as { op: string }).op === 'ping')
  expect(pings).toHaveLength(3)
  expect(client).toBeTruthy()
})
