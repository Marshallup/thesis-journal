import { randomUUID } from 'node:crypto'
import { ConfigService } from '@nestjs/config'
import { EventEmitter2 } from '@nestjs/event-emitter'
import { Money } from '@thesis/contracts'
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest'
import { PrismaService } from '../src/db/prisma.service.ts'
import { PricesConsumer } from '../src/prices/prices.consumer.ts'
import { PricesService } from '../src/prices/prices.service.ts'
import type { Env } from '../src/config/env.ts'
import type { PriceQuoted } from '@thesis/contracts'
import { withTestDb } from './setup-db.ts'

let db: Awaited<ReturnType<typeof withTestDb>>
let prisma: PrismaService
let consumer: PricesConsumer
let prices: PricesService
// Своя бумага на каждый тест: с общей они связаны через max(quoted_at), и
// «последняя цена» в одном тесте зависит от того, что записал соседний.
let instrumentId: string
let ticker = 0

// Брокер в тестах не поднимается: проверяется транзакция, в которой живёт вся
// идемпотентность, а не обещание Kafka доставить сообщение. Поэтому консьюмер
// собирается руками, без модуля — подключаться ему некуда и незачем.
const configStub = {
  get: () => 'localhost:9092',
} as unknown as ConfigService<Env, true>

function event(price: string, quotedAt: string): PriceQuoted {
  return { instrumentId, symbol: `TEST${ticker}`, source: 'moex', price, quotedAt }
}

function projectionRows(): Promise<number> {
  return prisma.instrumentPrice.count({ where: { instrumentId } })
}

// По всем бумагам: отметка не знает про инструмент, в ней только событие.
// Поэтому тесты сравнивают разницу, а не абсолютное значение.
function marks(): Promise<number> {
  return prisma.processedMessage.count()
}

beforeAll(async () => {
  db = await withTestDb()
  process.env.APP_DATABASE_URL = db.appUrl
  prisma = new PrismaService()
  await prisma.$connect()
  // Настоящий эмиттер, а не заглушка: слушателей в этом тесте нет, и объявить
  // событие в пустоту — ровно то, что делает консьюмер без шлюза.
  consumer = new PricesConsumer(prisma, configStub, new EventEmitter2())
  prices = new PricesService(prisma)
})

beforeEach(async () => {
  ticker += 1
  const instrument = await db.prisma.instrument.create({
    data: { symbol: `TEST${ticker}`, class: 'equity', currency: 'RUB' },
  })
  instrumentId = instrument.id
})

afterAll(async () => {
  await prisma.$disconnect()
  await db.stop()
})

it('применяет событие цены в проекцию', async () => {
  await consumer.apply(randomUUID(), event('291.68', '2026-10-22T13:00:00.000Z'))

  expect(await projectionRows()).toBe(1)
  const latest = await prices.latest()
  const quote = latest.find((row) => row.instrumentId === instrumentId)
  expect(Money.of(quote!.price).toString()).toBe('291.68')
})

// Relay может упасть между отправкой и отметкой, поэтому дубль — не сбой, а
// штатная работа. Этот тест важнее теста на счастливый путь.
it('повторная доставка того же события не создаёт второй строки', async () => {
  const eventId = randomUUID()
  const quoted = '2026-10-22T14:00:00.000Z'
  const before = await projectionRows()

  await consumer.apply(eventId, event('292.10', quoted))
  const marksAfterFirst = await marks()
  await consumer.apply(eventId, event('292.10', quoted))

  expect(await projectionRows()).toBe(before + 1)
  // Отметка тоже одна: вторая попытка упёрлась в уникальный индекс и вышла.
  expect(await marks()).toBe(marksAfterFirst)
})

// Тест, который и проверяет саму дедупликацию. Предыдущий её не проверяет:
// при одинаковом payload ключ проекции защищает и без отметки, поэтому убери
// дедупликацию — и тот тест останется зелёным. Здесь payload другой, и без
// отметки в проекции появилась бы вторая строка.
it('повтор события с изменённым содержимым игнорируется целиком', async () => {
  const eventId = randomUUID()
  const before = await projectionRows()

  await consumer.apply(eventId, event('295.00', '2026-10-22T17:00:00.000Z'))
  // То же событие, но «переписанное»: другое время и другая цена.
  await consumer.apply(eventId, event('999.00', '2026-10-22T18:00:00.000Z'))

  expect(await projectionRows()).toBe(before + 1)
  const history = await prices.history(instrumentId, new Date('2026-10-22T16:30:00.000Z'))
  expect(history.map((row) => row.price.toString())).not.toContain('999')
})

// Два разных события об одной и той же цене — это уже не дубль доставки, а
// повторная публикация. Защищает ключ проекции, а не отметка.
it('разные события об одной цене дают одну строку', async () => {
  const quoted = '2026-10-22T15:00:00.000Z'
  const before = await projectionRows()
  const marksBefore = await marks()

  await consumer.apply(randomUUID(), event('293.00', quoted))
  await consumer.apply(randomUUID(), event('293.00', quoted))

  expect(await projectionRows()).toBe(before + 1)
  expect(await marks()).toBe(marksBefore + 2)
})

// Опоздавшее событие ложится в историю и не становится последней ценой:
// «последняя» — это max(quoted_at), а не «та, что пришла позже».
it('опоздавшее событие не затирает свежую цену', async () => {
  await consumer.apply(randomUUID(), event('300.00', '2026-10-22T16:00:00.000Z'))
  await consumer.apply(randomUUID(), event('250.00', '2026-10-22T09:00:00.000Z'))

  const latest = await prices.latest()
  const quote = latest.find((row) => row.instrumentId === instrumentId)
  expect(Money.of(quote!.price).toString()).toBe('300')

  // При этом сама точка не потеряна.
  const history = await prices.history(instrumentId, new Date('2026-10-22T00:00:00.000Z'))
  expect(history.map((row) => row.price.toString())).toContain('250')
})
