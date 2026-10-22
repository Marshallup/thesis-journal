import { Injectable, Logger } from '@nestjs/common'
import type { OnApplicationBootstrap } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { Interval } from '@nestjs/schedule'
import type { Env } from '../config/env.ts'
import { PricesService } from './prices.service.ts'

const REFRESH_MS = 5 * 60 * 1000
// ISS лимита не публикует, но на частых обращениях отвечает 429. Своя нижняя
// граница на случай, если кто-то дёрнет обновление руками.
const MIN_INTERVAL_MS = 60 * 1000
// Размыкатель: после серии отказов перестаём ходить, пока не остынет. Без него
// упавший ISS получает запрос каждые пять минут вечно.
const FAILURES_TO_OPEN = 3
const COOLDOWN_MS = 15 * 60 * 1000

@Injectable()
export class PricesScheduler implements OnApplicationBootstrap {
  private readonly log = new Logger(PricesScheduler.name)
  private lastRun = 0
  private failures = 0
  private openedAt = 0

  constructor(
    private readonly prices: PricesService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  // Interval срабатывает только через пять минут после старта, а цена нужна
  // сразу: иначе свежеподнятое приложение показывает прочерки.
  onApplicationBootstrap(): Promise<void> {
    return this.refresh()
  }

  @Interval(REFRESH_MS)
  async refresh(): Promise<void> {
    // В тестах наружу не ходим вовсе: правило проекта — живых внешних вызовов
    // из тестов нет, только фикстуры.
    if (this.config.get('NODE_ENV', { infer: true }) === 'test') return

    const now = Date.now()
    if (now - this.lastRun < MIN_INTERVAL_MS) return
    if (this.failures >= FAILURES_TO_OPEN && now - this.openedAt < COOLDOWN_MS) return

    this.lastRun = now
    try {
      const { saved, seen } = await this.prices.refresh()
      this.failures = 0
      if (saved > 0) this.log.log(`котировки: сохранено ${saved} из ${seen} строк доски`)

      // После живых котировок, а не до: история нужна один раз, а свежая цена
      // каждый цикл, и падение истории не должно отменять её.
      const history = await this.prices.backfill()
      if (history.saved > 0) {
        this.log.log(`история: ${history.saved} дневных цен по ${history.filled} бумагам`)
      }
    } catch (error) {
      this.failures += 1
      if (this.failures === FAILURES_TO_OPEN) this.openedAt = now
      this.log.warn(`котировки не обновились (${this.failures}): ${String(error)}`)
    }
  }
}
