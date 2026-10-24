import { Inject, Injectable, Module } from '@nestjs/common'
import type { OnApplicationShutdown } from '@nestjs/common'
import type { Redis } from 'ioredis'
import { CircuitBreaker } from './circuit-breaker.ts'
import { ExternalCall } from './external-call.ts'
import { RateLimiter } from './rate-limiter.ts'
import { BybitMarket } from '../connectors/bybit/market.ts'
import { REDIS, redisProvider } from './redis.ts'

// Соединение закрывается по SIGTERM вместе со всем остальным: правило проекта
// требует, чтобы сервис дорабатывал и выходил, а не обрывался.
@Injectable()
class RedisLifecycle implements OnApplicationShutdown {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async onApplicationShutdown(): Promise<void> {
    // quit, а не disconnect: ждёт ответа на уже отправленные команды.
    await this.redis.quit()
  }
}

// Всё, что уходит из воркера наружу, идёт через этот модуль: правило проекта
// требует ограничителя и размыкателя на каждом внешнем вызове, а до сих пор
// лимит жил полями планировщика, то есть памятью одного процесса.
@Module({
  providers: [
    redisProvider,
    RateLimiter,
    CircuitBreaker,
    ExternalCall,
    RedisLifecycle,
    BybitMarket,
  ],
  exports: [ExternalCall, BybitMarket],
})
export class OutboundModule {}
