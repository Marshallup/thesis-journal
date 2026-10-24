import { Injectable } from '@nestjs/common'
import { ExternalCall } from '../../outbound/external-call.ts'

const BASE = 'https://api.bybit.com'
const TIMEOUT_MS = 10_000

// Минутная свеча: цена монеты в момент зачисления. Точнее минуты не нужно —
// депозит идёт в сети минутами, и секунда его зачисления сама по себе условна.
const INTERVAL = '1'
const MINUTE_MS = 60_000
const DAY_MS = 24 * 60 * 60 * 1000
// Тысяча свечей за запрос — максимум биржи. Три года дневных закрытий
// умещаются в один.
const PAGE = 1000

type KlineResponse = {
  retCode: number
  retMsg: string
  // [время, открытие, максимум, минимум, закрытие, объём, оборот] — строками.
  result: { list: string[][] }
}

// Публичные свечи: подпись не нужна, ключ тоже. Отдельный клиент, а не метод
// подписанного: добавить подпись к публичному запросу значит отправить ключ
// туда, где он не требуется.
@Injectable()
export class BybitMarket {
  constructor(private readonly calls: ExternalCall) {}

  // Текущие цены всех спотовых пар одним запросом. Перечислять свои — значит
  // делать двадцать запросов там, где биржа отдаёт всё разом; стоимость не
  // зависит от числа наших бумаг, как и у доски MOEX.
  async tickers(): Promise<Map<string, string>> {
    const response = await this.calls.run('bybit', () =>
      fetch(`${BASE}/v5/market/tickers?category=spot`, {
        signal: AbortSignal.timeout(TIMEOUT_MS),
      }),
    )
    if (!response.ok) throw new Error(`Bybit тикеры ответили ${response.status}`)

    const body = (await response.json()) as {
      retCode: number
      retMsg: string
      result: { list: { symbol: string; lastPrice: string }[] }
    }
    if (body.retCode !== 0) throw new Error(`Bybit тикеры: ${body.retCode} ${body.retMsg}`)

    return new Map(
      body.result.list
        .filter((row) => Number(row.lastPrice) > 0)
        .map((row) => [row.symbol, row.lastPrice]),
    )
  }

  // Дневные закрытия с указанной даты. Нужны не для красоты графика: без
  // истории нельзя посчитать ни стоимость портфеля на дату, ни результат за
  // год — а дневник читается именно так.
  async dailyCloses(symbol: string, from: Date): Promise<{ price: string; quotedAt: Date }[]> {
    const closes: { price: string; quotedAt: Date }[] = []
    let start = from.getTime()

    for (;;) {
      const query = new URLSearchParams({
        category: 'spot',
        symbol,
        interval: 'D',
        start: String(start),
        limit: String(PAGE),
      })
      const response = await this.calls.run('bybit', () =>
        fetch(`${BASE}/v5/market/kline?${query.toString()}`, {
          signal: AbortSignal.timeout(TIMEOUT_MS),
        }),
      )
      if (!response.ok) throw new Error(`Bybit свечи ответили ${response.status}`)

      const body = (await response.json()) as KlineResponse
      // Пары нет на бирже — делистинг или её тут не было вовсе. Не авария:
      // цикл должен дойти до остальных.
      if (body.retCode !== 0) return closes

      // Биржа отдаёт свежие первыми; разворачиваем, чтобы идти по времени.
      const page = body.result.list.toReversed()
      for (const row of page) {
        const at = Number(row[0])
        const close = row[4]
        if (!close || Number(close) <= 0) continue
        // Дневная свеча открывается в полночь UTC; цена закрытия относится к
        // концу дня, и временем ставится он же — полночь следующего дня была
        // бы уже другим днём.
        closes.push({ price: close, quotedAt: new Date(at + DAY_MS - 1000) })
      }

      if (page.length < PAGE) return closes
      const last = page.at(-1)?.[0]
      if (!last) return closes
      start = Number(last) + DAY_MS
    }
  }

  // Цена закрытия минуты, в которую случилось событие. null — биржа не знает
  // такой пары или не отдала свечу: выдумывать цену нельзя, пусть будет
  // «неизвестно».
  async closeAt(symbol: string, at: Date): Promise<string | null> {
    const start = Math.floor(at.getTime() / MINUTE_MS) * MINUTE_MS
    const query = new URLSearchParams({
      category: 'spot',
      symbol,
      interval: INTERVAL,
      start: String(start),
      end: String(start + MINUTE_MS),
      limit: '1',
    })

    const response = await this.calls.run('bybit', () =>
      fetch(`${BASE}/v5/market/kline?${query.toString()}`, {
        signal: AbortSignal.timeout(TIMEOUT_MS),
      }),
    )
    if (!response.ok) throw new Error(`Bybit свечи ответили ${response.status}`)

    const body = (await response.json()) as KlineResponse
    // Неизвестная пара — это не авария: монета могла не торговаться на этой
    // бирже вовсе. Отличается от сетевой ошибки тем, что повтор не поможет.
    if (body.retCode !== 0) return null

    return body.result.list[0]?.[4] ?? null
  }
}
