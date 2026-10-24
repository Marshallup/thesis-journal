import { Injectable, Logger } from '@nestjs/common'
import type { OnApplicationBootstrap } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { Interval } from '@nestjs/schedule'
import type { Env } from '../config/env.ts'
import { CryptoPricesService } from './crypto.service.ts'
import { PricesService } from './prices.service.ts'

const REFRESH_MS = 5 * 60 * 1000
// ISS лимита не публикует, но на частых обращениях отвечает 429. Своя нижняя
// граница на случай, если кто-то дёрнет обновление руками.
const MIN_INTERVAL_MS = 60 * 1000

// Размыкателя здесь больше нет: он общий и живёт в Redis (задача 23). Два
// размыкателя на одного провайдера хуже одного — непонятно, который сработал.

@Injectable()
export class PricesScheduler implements OnApplicationBootstrap {
  private readonly log = new Logger(PricesScheduler.name)
  private lastRun = 0

  constructor(
    private readonly prices: PricesService,
    private readonly crypto: CryptoPricesService,
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

    this.lastRun = now
    try {
      const { saved, seen } = await this.prices.refresh()
      if (saved > 0) this.log.log(`котировки: сохранено ${saved} из ${seen} строк доски`)

      // После живых котировок, а не до: история нужна один раз, а свежая цена
      // каждый цикл, и падение истории не должно отменять её.
      const history = await this.prices.backfill()
      if (history.saved > 0) {
        this.log.log(`история: ${history.saved} дневных цен по ${history.filled} бумагам`)
      }

      // Крипта тем же путём и в том же цикле: другой провайдер, те же
      // проекция, outbox и ограничитель. Своего расписания ей не нужно —
      // цена меняется чаще, но дневник не торговый терминал.
      const coins = await this.crypto.refresh()
      if (coins.saved > 0) this.log.log(`крипта: сохранено ${coins.saved} из ${coins.seen} пар`)

      const coinHistory = await this.crypto.backfill()
      if (coinHistory.saved > 0) {
        this.log.log(`крипта: ${coinHistory.saved} дневных цен по ${coinHistory.filled} парам`)
      }
    } catch (error) {
      // Отказы считает размыкатель; здесь остаётся сказать об этом вслух —
      // молчащий цикл опроса выглядит как работающий.
      this.log.warn(`котировки не обновились: ${String(error)}`)
    }
  }
}
