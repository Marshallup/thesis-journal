import { Injectable } from '@nestjs/common'
import { CircuitBreaker } from './circuit-breaker.ts'
import { RateLimiter } from './rate-limiter.ts'
import type { Budget } from './rate-limiter.ts'

// Бюджеты провайдеров. Числа сознательно ниже всего, что обещают сами
// провайдеры: ISS лимита не публикует вовсе и отвечает 429 по факту, Bybit
// считает запросы по своим правилам — на эндпоинт, на ключ и на адрес. Упираться
// в потолок ради лишнего запроса в секунду дневнику незачем.
const BUDGETS = {
  // Опрос доски — раз в пять минут, история — раз на запуск. Десять подряд с
  // восстановлением по одному в секунду покрывает и то, и другое.
  moex: { capacity: 10, refillPerSec: 1 },
  bybit: { capacity: 10, refillPerSec: 5 },
  // Курс ЦБ спрашивается раз в сутки; бюджет здесь — страховка от цикла,
  // а не от нагрузки.
  cbr: { capacity: 5, refillPerSec: 1 },
} satisfies Record<string, Budget>

export type Provider = keyof typeof BUDGETS

@Injectable()
export class ExternalCall {
  constructor(
    private readonly limiter: RateLimiter,
    private readonly breaker: CircuitBreaker,
  ) {}

  // Размыкатель снаружи, ограничитель внутри: пока провайдер лежит, ждать
  // своей очереди и тратить токены незачем.
  run<T>(provider: Provider, fn: () => Promise<T>): Promise<T> {
    return this.breaker.run(provider, async () => {
      await this.limiter.take(provider, BUDGETS[provider])
      return fn()
    })
  }
}
