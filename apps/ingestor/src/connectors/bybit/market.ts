import { Injectable } from '@nestjs/common'
import { ExternalCall } from '../../outbound/external-call.ts'

const BASE = 'https://api.bybit.com'
const TIMEOUT_MS = 10_000

// Минутная свеча: цена монеты в момент зачисления. Точнее минуты не нужно —
// депозит идёт в сети минутами, и секунда его зачисления сама по себе условна.
const INTERVAL = '1'
const MINUTE_MS = 60_000

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
