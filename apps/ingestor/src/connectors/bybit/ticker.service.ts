import { Injectable, Logger } from '@nestjs/common'
import { PrismaService } from '../../db/prisma.service.ts'
import { CryptoPricesService } from '../../prices/crypto.service.ts'
import { BybitWsClient } from './ws-client.ts'
import type { Tick } from './ws-client.ts'

// Одна цена на символ за пятнадцать секунд. Дневник решений не торговый
// терминал: цена с точностью до стомиллисекунды здесь не значит ничего, а
// стоит гигабайтов.
const WINDOW_MS = 15_000

@Injectable()
export class BybitTickerService {
  private readonly log = new Logger(BybitTickerService.name)
  // Тикер → инструмент: поток приходит символами, а писать надо по id.
  private readonly instruments = new Map<string, string>()
  // Последнее записанное окно по символу. Защита от потока; настоящая защита
  // от двойной записи — ключ (инструмент, источник, время) в базе, он работает
  // и при второй реплике.
  private readonly windows = new Map<string, number>()
  private listening = false

  constructor(
    private readonly prisma: PrismaService,
    private readonly client: BybitWsClient,
    private readonly prices: CryptoPricesService,
  ) {}

  // Зовётся из цикла цен, а не из своего расписания: пары в справочнике
  // появляются фактом сделки, и узнавать о новых надо тогда же, когда об их
  // ценах.
  async sync(): Promise<number> {
    const pairs = await this.prisma.instrument.findMany({
      where: { class: 'crypto' },
      select: { id: true, symbol: true },
    })
    for (const pair of pairs) this.instruments.set(pair.symbol, pair.id)

    if (!this.listening) {
      this.client.onTick((tick) => void this.onTick(tick))
      this.listening = true
    }
    this.client.subscribe(pairs.map((pair) => pair.symbol))
    return pairs.length
  }

  // Цена из потока идёт тем же путём, что цена из опроса: проекция в api
  // строится событиями, и отдельного пути у тика нет.
  async onTick(tick: Tick): Promise<number> {
    const instrumentId = this.instruments.get(tick.symbol)
    // Пара, которой нет в справочнике: мы её не покупали, цена не нужна.
    if (!instrumentId) return 0

    const window = Math.floor(tick.at.getTime() / WINDOW_MS) * WINDOW_MS
    if (this.windows.get(tick.symbol) === window) return 0
    // Окно занимается до записи, а не после: иначе сто тиков одного окна
    // успеют пройти проверку, пока первая запись ещё идёт.
    this.windows.set(tick.symbol, window)

    try {
      return await this.prices.save([
        {
          instrumentId,
          symbol: tick.symbol,
          price: tick.price,
          // Время — начало окна: тик внутри него выбран произвольно, и
          // хранить его момент значило бы показывать точность, которой нет.
          quotedAt: new Date(window),
        },
      ])
    } catch (error) {
      // Окно освобождается: иначе одна неудачная запись выключает пару до
      // следующего окна, а причина могла быть разовой.
      this.windows.delete(tick.symbol)
      this.log.warn(`тик ${tick.symbol} не записан: ${String(error)}`)
      return 0
    }
  }
}
