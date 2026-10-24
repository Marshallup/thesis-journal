import { randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { JwtService } from '@nestjs/jwt'
import { Test } from '@nestjs/testing'
import { WebSocket } from 'ws'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { AppModule } from '../src/app.module.ts'
import { configureApp } from '../src/config/configure-app.ts'
import { PricesConsumer } from '../src/prices/prices.consumer.ts'
import { TradesService } from '../src/trades/trades.service.ts'
import { withTestDb } from './setup-db.ts'

let app: Awaited<ReturnType<typeof createApp>>
let db: Awaited<ReturnType<typeof withTestDb>>
let consumer: PricesConsumer
let port = 0
// Боб держит бумагу, Алиса — ничего: на этой разнице и проверяется изоляция.
let bob: { token: string; instrumentId: string }
let aliceToken = ''

type Message = {
  event: string
  data: { total: string; currency: string; incomplete: boolean; ts: string }
}

async function createApp() {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
  const instance = moduleRef.createNestApplication()
  // Та же настройка, что в bootstrap: adapter сокетов подключается там же, где
  // префикс и версии, иначе тест проверяет другой транспорт, чем прод.
  configureApp(instance)
  await instance.init()
  // Порт нулевой: параллельные прогоны не спорят за него, а WebSocket без
  // слушающего сервера не поднять.
  await instance.listen(0)
  return instance
}

function tokenFor(userId: string): Promise<string> {
  return app.get(JwtService).signAsync({ sub: userId })
}

async function seedUser(email: string): Promise<string> {
  const user = await db.prisma.user.create({ data: { email, passwordHash: 'x' } })
  return user.id
}

function open(): Promise<WebSocket> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`)
  return new Promise((resolve, reject) => {
    socket.once('open', () => resolve(socket))
    socket.once('error', reject)
  })
}

// Конверт шлюза, а не свой: `{ event, data }` — то, что разбирает adapter.
function auth(socket: WebSocket, token: string): void {
  socket.send(JSON.stringify({ event: 'auth', data: { token } }))
}

function collect(socket: WebSocket): Message[] {
  const seen: Message[] = []
  socket.on('message', (raw) => seen.push(JSON.parse(String(raw)) as Message))
  return seen
}

function closedWith(socket: WebSocket): Promise<number> {
  return new Promise((resolve) => socket.once('close', (code: number) => resolve(code)))
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// Цена приезжает тем же путём, что в проде, но без брокера: консьюмер
// публичный ровно для этого.
async function pushPrice(instrumentId: string, price: string): Promise<void> {
  await consumer.apply(randomUUID(), {
    instrumentId,
    symbol: 'LIVE',
    source: 'moex',
    price,
    quotedAt: new Date().toISOString(),
  })
}

beforeAll(async () => {
  db = await withTestDb()
  process.env.DATABASE_URL = db.url
  process.env.APP_DATABASE_URL = db.appUrl
  app = await createApp()
  consumer = app.get(PricesConsumer)
  port = (app.getHttpServer().address() as AddressInfo).port

  const bobId = await seedUser(`bob-${randomUUID()}@example.com`)
  const account = await db.prisma.account.create({
    data: { userId: bobId, provider: 'sber', kind: 'broker', baseCurrency: 'RUB' },
  })
  const instrument = await db.prisma.instrument.create({
    data: { symbol: `LIVE${randomUUID().slice(0, 6)}`, class: 'equity', currency: 'RUB' },
  })
  // Десять бумаг по сто: с ценой 150 нереализованное даст ровно 500.
  await app.get(TradesService).apply(bobId, {
    accountId: account.id,
    instrumentId: instrument.id,
    side: 'buy',
    quantity: '10',
    price: '100',
    fee: '0',
    executedAt: '2026-10-01T10:00:00.000Z',
  })
  bob = { token: await tokenFor(bobId), instrumentId: instrument.id }
  aliceToken = await tokenFor(await seedUser(`alice-${randomUUID()}@example.com`))
})

afterAll(async () => {
  await app.close()
  await db.stop()
})

// Главный тест задачи: сокет — это канал, у которого нет пути и заголовка, и
// перепутать в нём клиентов легче, чем в REST. Цена Боба не должна приносить
// Алисе ни его итог, ни сам факт, что у него что-то изменилось.
it('не шлёт клиенту чужой портфель', async () => {
  const socket = await open()
  const seen = collect(socket)
  auth(socket, aliceToken)
  await wait(300)

  await pushPrice(bob.instrumentId, '150')
  await wait(1300)
  socket.close()

  // Сообщения есть — иначе тест был бы зелёным просто потому, что шлюз молчит.
  expect(seen.length).toBeGreaterThan(0)
  expect(seen.every((message) => message.data.total === '0')).toBe(true)
  expect(seen.some((message) => message.data.total === '500')).toBe(false)
})

// Обратная сторона того же: своё число должно приезжать само, без перезагрузки
// страницы. Без этой проверки изоляция «работает» и на полностью мёртвом шлюзе.
it('свой итог приезжает после применённой цены', async () => {
  const socket = await open()
  const seen = collect(socket)
  auth(socket, bob.token)
  await wait(300)

  await pushPrice(bob.instrumentId, '150')
  await wait(1300)
  socket.close()

  expect(seen.at(-1)?.data).toMatchObject({ total: '500', currency: 'RUB' })
})

// Токен идёт первым сообщением, а не в query-строке: query попадает в логи
// прокси целиком. До авторизации сокет не получает ничего и закрывается сам.
it('без токена сокет не получает ничего и закрывается', async () => {
  const socket = await open()
  const seen = collect(socket)
  const closed = closedWith(socket)

  await pushPrice(bob.instrumentId, '151')
  await wait(300)
  expect(seen).toEqual([])

  expect(await closed).toBe(4401)
})

it('неверный токен закрывает соединение, а не остаётся без ответа', async () => {
  const socket = await open()
  const closed = closedWith(socket)

  auth(socket, 'not-a-token')

  expect(await closed).toBe(4401)
})

// Сто тиков в секунду не повод слать сто сообщений: браузер захлёбывается, а
// человек цену десять раз в секунду не читает.
it('не чаще одного сообщения в секунду на клиента', async () => {
  const socket = await open()
  const seen = collect(socket)
  auth(socket, bob.token)
  await wait(200)

  for (let i = 0; i < 5; i += 1) await pushPrice(bob.instrumentId, String(150 + i))
  await wait(1400)
  socket.close()

  // Первое — сразу после авторизации, второе — за все пять цен разом.
  expect(seen).toHaveLength(2)
})
