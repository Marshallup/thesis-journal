import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest'
import { RateLimiter } from '../src/outbound/rate-limiter.ts'
import type { Redis } from 'ioredis'
import { withTestRedis } from './setup-redis.ts'

let redis: Awaited<ReturnType<typeof withTestRedis>>
let control: Redis

// Десять запросов залпом и десять в секунду на восстановление: числа выбраны
// так, чтобы тридцать запросов заведомо не укладывались в мгновение.
const budget = { capacity: 10, refillPerSec: 10 }

beforeAll(async () => {
  redis = await withTestRedis()
  control = redis.client()
})

beforeEach(async () => {
  await control.flushall()
})

afterAll(async () => {
  await redis.stop()
})

// Главное свойство: лимит один на всех, а не на процесс. Три лимитера — это
// три реплики воркера, и вместе они обязаны уложиться в тот же бюджет.
it('три реплики вместе не превышают лимит провайдера', async () => {
  const limiters = [1, 2, 3].map(() => new RateLimiter(redis.client()))

  const started = Date.now()
  await Promise.all(
    limiters.flatMap((limiter) => Array.from({ length: 10 }, () => limiter.take('bybit', budget))),
  )
  const elapsed = Date.now() - started

  // Тридцать запросов при десяти в секунду — минимум две секунды, если бюджет
  // действительно общий. С лимитером в памяти процесса всё прошло бы мгновенно,
  // то есть лимит был бы утроен.
  expect(elapsed).toBeGreaterThanOrEqual(1900)
})

it('залп в размер бюджета проходит без ожидания', async () => {
  const limiter = new RateLimiter(redis.client())

  const started = Date.now()
  for (let i = 0; i < budget.capacity; i += 1) await limiter.take('moex', budget)

  expect(Date.now() - started).toBeLessThan(500)
})

// Бюджет восстанавливается со временем, а не обнуляется до следующего окна:
// иначе опрос, попавший в конец окна, ждал бы его целиком.
it('бюджет восстанавливается со временем', async () => {
  const limiter = new RateLimiter(redis.client())
  for (let i = 0; i < budget.capacity; i += 1) await limiter.take('moex', budget)

  const started = Date.now()
  await limiter.take('moex', budget)
  const waited = Date.now() - started

  // Один токен при десяти в секунду — около ста миллисекунд, а не секунда.
  expect(waited).toBeGreaterThanOrEqual(50)
  expect(waited).toBeLessThan(600)
})

// Ведро у каждого провайдера своё: упёршийся в лимит MOEX не должен
// придерживать запросы к бирже.
it('провайдеры не делят одно ведро', async () => {
  const limiter = new RateLimiter(redis.client())
  for (let i = 0; i < budget.capacity; i += 1) await limiter.take('moex', budget)

  const started = Date.now()
  await limiter.take('bybit', budget)

  expect(Date.now() - started).toBeLessThan(500)
})

// Запрос дороже всего бюджета не станет возможным никогда: ждать его значит
// повиснуть навсегда, и лучше сказать об этом сразу.
it('запрос дороже бюджета отбивается, а не ждёт вечно', async () => {
  const limiter = new RateLimiter(redis.client())

  await expect(limiter.take('moex', budget, budget.capacity + 1)).rejects.toThrow(/бюджет/)
})
