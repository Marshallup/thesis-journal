import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { CircuitBreaker, CircuitOpen } from '../src/outbound/circuit-breaker.ts'
import type { Redis } from 'ioredis'
import { withTestRedis } from './setup-redis.ts'

let redis: Awaited<ReturnType<typeof withTestRedis>>
let control: Redis
let breaker: CircuitBreaker

const fails = () => Promise.reject(new Error('провайдер ответил 429'))

async function failTimes(times: number, which: CircuitBreaker = breaker): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await expect(which.run('bybit', fails)).rejects.toThrow('429')
  }
}

beforeAll(async () => {
  redis = await withTestRedis()
  control = redis.client()
  breaker = new CircuitBreaker(redis.client())
})

beforeEach(async () => {
  await control.flushall()
})

afterAll(async () => {
  await redis.stop()
})

// Смысл размыкателя: после серии отказов запроса не происходит вовсе. Без него
// упавший провайдер получает запрос каждый цикл, пока не оживёт.
it('после пяти отказов подряд запрос не отправляется', async () => {
  await failTimes(5)

  const fn = vi.fn()
  await expect(breaker.run('bybit', fn)).rejects.toThrow(CircuitOpen)
  expect(fn).not.toHaveBeenCalled()
})

// Состояние общее: иначе одна реплика остывает, а вторая долбит, и размыкатель
// не размыкает ничего. Проверяется двумя экземплярами на одном Redis.
it('отказы одной реплики размыкают вторую', async () => {
  const first = new CircuitBreaker(redis.client())
  const second = new CircuitBreaker(redis.client())

  await failTimes(5, first)

  const fn = vi.fn()
  await expect(second.run('bybit', fn)).rejects.toThrow(CircuitOpen)
  expect(fn).not.toHaveBeenCalled()
})

// Пять отказов должны быть подряд. Успех между ними — это работающий
// провайдер, и копить ему отказы незачем.
it('успех обнуляет счётчик отказов', async () => {
  await failTimes(4)
  await expect(breaker.run('bybit', () => Promise.resolve('ок'))).resolves.toBe('ок')
  await failTimes(4)

  // Девять отказов всего, но подряд — только четыре: размыкатель закрыт.
  const fn = vi.fn(() => Promise.resolve('ок'))
  await expect(breaker.run('bybit', fn)).resolves.toBe('ок')
})

// Минута — это минута, а не «до перезапуска процесса»: срок живёт в Redis, и
// истекает он сам. Поэтому проверяем сам срок, а не ждём его.
it('размыкатель открыт на минуту и закрывается сам', async () => {
  await failTimes(5)

  const ttl = await control.pttl('breaker:open:bybit')
  expect(ttl).toBeGreaterThan(0)
  expect(ttl).toBeLessThanOrEqual(60_000)

  // Срок истёк — следующий запрос пробный, и он проходит.
  await control.del('breaker:open:bybit')
  await expect(breaker.run('bybit', () => Promise.resolve('ок'))).resolves.toBe('ок')
})

// Провайдеры независимы: лежащая биржа не должна отключать опрос котировок.
it('размыкатель у каждого провайдера свой', async () => {
  await failTimes(5)

  await expect(breaker.run('moex', () => Promise.resolve('ок'))).resolves.toBe('ок')
})
