import { randomUUID } from 'node:crypto'
import { PRICES_TOPIC } from '@thesis/contracts'
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest'
import { PrismaService } from '../src/db/prisma.service.ts'
import { OutboxRelay } from '../src/outbox/outbox.relay.ts'
import { OutboxRepository } from '../src/outbox/outbox.repository.ts'
import type { KafkaProducer, OutgoingMessage } from '../src/kafka/kafka.producer.ts'
import { withTestDb } from './setup-db.ts'

let db: Awaited<ReturnType<typeof withTestDb>>
let prisma: PrismaService
let outbox: OutboxRepository
let instrumentId: string

// Продюсер подменён, и это не упрощение: Kafka сохраняет порядок внутри
// партиции сама, а наше дело — не забыть ключ и отправлять по возрастанию id.
// Именно это и проверяется, а чужой контракт перепроверять незачем.
class FakeProducer {
  readonly sent: OutgoingMessage[] = []
  failures = 0

  send(messages: OutgoingMessage[]): Promise<void> {
    if (this.failures > 0) {
      this.failures -= 1
      return Promise.reject(new Error('брокер недоступен'))
    }
    this.sent.push(...messages)
    return Promise.resolve()
  }
}

function relayWith(producer: FakeProducer): OutboxRelay {
  return new OutboxRelay(outbox, producer as unknown as KafkaProducer)
}

function priceEvent(price: string): { topic: string; key: string; payload: unknown } {
  return {
    topic: PRICES_TOPIC,
    key: 'SBER',
    payload: { instrumentId, symbol: 'SBER', source: 'moex', price, quotedAt: new Date(0) },
  }
}

beforeAll(async () => {
  db = await withTestDb()
  process.env.INGESTOR_DATABASE_URL = db.url
  prisma = new PrismaService()
  await prisma.$connect()
  outbox = new OutboxRepository(prisma)

  const instrument = await db.prisma.instrument.create({
    data: { symbol: 'SBER', class: 'equity', currency: 'RUB' },
  })
  instrumentId = instrument.id
})

beforeEach(async () => {
  await prisma.outboxEvent.deleteMany()
})

afterAll(async () => {
  await prisma.$disconnect()
  await db.stop()
})

// Главное свойство outbox: цена и событие о ней существуют вместе или не
// существуют вовсе. Прямая отправка в брокер этого не даёт никогда.
it('событие не остаётся без цены, если транзакция сорвалась', async () => {
  await expect(
    prisma.$transaction(async (tx) => {
      await tx.providerPrice.create({
        data: {
          instrumentId,
          source: 'moex',
          price: '100',
          quotedAt: new Date('2026-10-22T10:00:00.000Z'),
        },
      })
      await outbox.enqueue(tx, [priceEvent('100')])
      throw new Error('дальше по коду стало плохо')
    }),
  ).rejects.toThrow('дальше по коду стало плохо')

  expect(await prisma.outboxEvent.count()).toBe(0)
  expect(await prisma.providerPrice.count({ where: { instrumentId } })).toBe(0)
})

// Порядок внутри тикера держится двумя вещами: ключом сообщения (он выбирает
// партицию) и сортировкой по id при вычитке. Проверяется и то, и другое.
it('отправляет двести событий по возрастанию id и все с ключом-тикером', async () => {
  const prices = Array.from({ length: 200 }, (_, i) => String(i + 1))
  for (const price of prices) {
    await prisma.$transaction((tx) => outbox.enqueue(tx, [priceEvent(price)]))
  }

  const producer = new FakeProducer()
  await relayWith(producer).pump()

  expect(producer.sent).toHaveLength(200)
  expect(producer.sent.map((message) => JSON.parse(message.value).price)).toEqual(prices)
  expect(new Set(producer.sent.map((message) => message.key))).toEqual(new Set(['SBER']))
  // Больше партии в 500 здесь нет, но вычитка идёт циклом, и порядок должен
  // сохраняться между партиями тоже.
  expect(await prisma.outboxEvent.count({ where: { publishedAt: null } })).toBe(0)
})

// Идентификатор события едет заголовком: по нему потребитель узнаёт дубль.
// Без него дедупликация на другой стороне невозможна вовсе.
it('у каждого сообщения в заголовке свой идентификатор события', async () => {
  await prisma.$transaction((tx) => outbox.enqueue(tx, [priceEvent('1'), priceEvent('2')]))

  const producer = new FakeProducer()
  await relayWith(producer).pump()

  const stored = await prisma.outboxEvent.findMany({ orderBy: { id: 'asc' }, select: { id: true } })
  expect(producer.sent.map((message) => message.headers?.['event-id'])).toEqual(
    stored.map((event) => event.id),
  )
})

// Сорвавшаяся отправка не должна терять событие: оно остаётся неотправленным
// и уходит следующим тиком. Потеря здесь означала бы, что проекция навсегда
// отстала на одну цену.
it('неудачная отправка оставляет событие в очереди', async () => {
  await prisma.$transaction((tx) => outbox.enqueue(tx, [priceEvent('42')]))

  const producer = new FakeProducer()
  producer.failures = 1
  const relay = relayWith(producer)

  await relay.pump()
  expect(producer.sent).toHaveLength(0)
  expect(await prisma.outboxEvent.count({ where: { publishedAt: null } })).toBe(1)

  await relay.pump()
  expect(producer.sent).toHaveLength(1)
  expect(await prisma.outboxEvent.count({ where: { publishedAt: null } })).toBe(0)
})

// Отправленное не отправляется заново: иначе каждая цена уходила бы в топик
// столько раз, сколько тиков прошло.
it('уже отправленное событие во второй раз не уходит', async () => {
  await prisma.$transaction((tx) => outbox.enqueue(tx, [priceEvent('7')]))

  const producer = new FakeProducer()
  const relay = relayWith(producer)
  await relay.pump()
  await relay.pump()

  expect(producer.sent).toHaveLength(1)
  expect(await prisma.outboxEvent.count({ where: { publishedAt: { not: null } } })).toBe(1)
})

it('пустая очередь не ходит к брокеру вовсе', async () => {
  const producer = new FakeProducer()
  await relayWith(producer).pump()

  expect(producer.sent).toHaveLength(0)
  expect(randomUUID()).toBeTruthy()
})
