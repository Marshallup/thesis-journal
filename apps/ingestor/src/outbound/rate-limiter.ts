import { Inject, Injectable } from '@nestjs/common'
import type { Redis } from 'ioredis'
import { REDIS } from './redis.ts'

export type Budget = {
  // Сколько запросов можно сделать «залпом».
  capacity: number
  // С какой скоростью бюджет восстанавливается.
  refillPerSec: number
}

// Token bucket целиком в одном скрипте: проверка остатка и списание — одна
// операция. Двумя командами это гонка, которую правило проекта запрещает прямо:
// две реплики прочитают одно значение и спишут дважды.
//
// Время берётся у Redis (TIME), а не у процесса: часы реплик расходятся, и
// ведро, которое пополняется по часам самого быстрого, течёт.
//
// Скрипт — строка в коде, а не отдельный .lua: `nest build` копирует только
// то, что перечислено в assets, и файл, забытый в сборке, сломал бы воркер
// в проде, а не в тестах.
const TOKEN_BUCKET = `
local capacity = tonumber(ARGV[1])
local refill = tonumber(ARGV[2])
local cost = tonumber(ARGV[3])

local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)

local state = redis.call('HMGET', KEYS[1], 'tokens', 'updated')
local tokens = tonumber(state[1])
local updated = tonumber(state[2])
if tokens == nil or updated == nil then
  tokens = capacity
  updated = now
end

tokens = math.min(capacity, tokens + (now - updated) * refill / 1000)

local wait = 0
if tokens >= cost then
  tokens = tokens - cost
else
  wait = math.ceil((cost - tokens) * 1000 / refill)
end

redis.call('HMSET', KEYS[1], 'tokens', tokens, 'updated', now)
-- Полное ведро хранить незачем: следующий запрос начнёт с полного.
redis.call('PEXPIRE', KEYS[1], math.ceil(capacity * 1000 / refill) + 1000)
return wait
`

type RedisWithBucket = Redis & {
  takeTokens(key: string, capacity: number, refill: number, cost: number): Promise<number>
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

@Injectable()
export class RateLimiter {
  private readonly redis: RedisWithBucket

  constructor(@Inject(REDIS) redis: Redis) {
    this.redis = redis as RedisWithBucket
    // defineCommand объявляет скрипт один раз: дальше ioredis сам ходит через
    // EVALSHA и перезагружает тело, если Redis ответил NOSCRIPT.
    this.redis.defineCommand('takeTokens', { numberOfKeys: 1, lua: TOKEN_BUCKET })
  }

  // Ждёт своей очереди, а не отказывает: вызывающему нужен ответ провайдера, а
  // не ошибка «слишком быстро». Отказ — дело размыкателя.
  async take(bucket: string, budget: Budget, cost = 1): Promise<void> {
    if (cost > budget.capacity) {
      throw new Error(`запрос дороже всего бюджета ${bucket}: ${cost} > ${budget.capacity}`)
    }

    for (;;) {
      const wait = await this.redis.takeTokens(
        `rate:${bucket}`,
        budget.capacity,
        budget.refillPerSec,
        cost,
      )
      if (wait <= 0) return
      await sleep(wait)
    }
  }
}
