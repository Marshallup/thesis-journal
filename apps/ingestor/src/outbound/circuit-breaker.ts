import { Inject, Injectable, Logger } from '@nestjs/common'
import type { Redis } from 'ioredis'
import { REDIS } from './redis.ts'

// Пять отказов подряд — это не случайность, а провайдер лежит.
const FAILURES_TO_OPEN = 5
// Минуту не ходим вовсе, дальше — один пробный запрос: его пропустит сам
// Redis, когда ключ истечёт.
const OPEN_MS = 60_000
// Окно, за которое считаются отказы. Без него счётчик копил бы по одному
// отказу в день и однажды разомкнул исправного провайдера.
const WINDOW_MS = 5 * 60_000

// Отличается от ошибки провайдера намеренно: вызывающий должен понимать, что
// запроса не было вовсе.
export class CircuitOpen extends Error {}

// INCR и PEXPIRE одной операцией: иначе падение между ними оставляет счётчик
// без срока жизни, и он копит отказы вечно.
const COUNT_FAILURE = `
local fails = redis.call('INCR', KEYS[1])
if fails == 1 then
  redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[1]))
end
return fails
`

type RedisWithCounter = Redis & {
  countFailure(key: string, windowMs: number): Promise<number>
}

@Injectable()
export class CircuitBreaker {
  private readonly log = new Logger(CircuitBreaker.name)
  private readonly redis: RedisWithCounter

  constructor(@Inject(REDIS) redis: Redis) {
    this.redis = redis as RedisWithCounter
    this.redis.defineCommand('countFailure', { numberOfKeys: 1, lua: COUNT_FAILURE })
  }

  // Состояние в Redis, а не в полях объекта: при двух репликах локальный
  // размыкатель означает, что одна остывает, а вторая долбит — то есть не
  // размыкает ничего.
  async run<T>(provider: string, fn: () => Promise<T>): Promise<T> {
    const open = `breaker:open:${provider}`
    const fails = `breaker:fails:${provider}`

    if ((await this.redis.exists(open)) === 1) {
      throw new CircuitOpen(`${provider}: размыкатель открыт, запрос не отправлен`)
    }

    try {
      const result = await fn()
      // Успех обнуляет счётчик: пять отказов должны быть подряд, а не пять
      // за всё время.
      await this.redis.del(fails)
      return result
    } catch (error) {
      const count = await this.redis.countFailure(fails, WINDOW_MS)
      if (count >= FAILURES_TO_OPEN) {
        await this.redis.set(open, '1', 'PX', OPEN_MS)
        await this.redis.del(fails)
        this.log.warn(`${provider}: ${count} отказов подряд, размыкаю на минуту`)
      }
      throw error
    }
  }
}
