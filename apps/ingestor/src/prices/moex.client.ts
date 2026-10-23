import { Injectable } from '@nestjs/common'
import { ExternalCall } from '../outbound/external-call.ts'

// Доска основного режима торгов акциями. У облигаций и фондов свои: тикер без
// доски неоднозначен.
const BOARD = 'TQBR'
const BASE = 'https://iss.moex.com/iss/engines/stock/markets/shares/boards'
const HISTORY = 'https://iss.moex.com/iss/history/engines/stock/markets/shares/boards'

// Вся доска одним запросом, без перечисления тикеров: замерено — 510 строк,
// курсора нет, 31 КБ с фильтром по колонкам против 198 без него. Стоимость
// цикла от числа пользователей не зависит вовсе.
const COLUMNS = ['SECID', 'LAST', 'MARKETPRICE', 'PREVPRICE', 'UPDATETIME', 'SYSTIME'] as const

export type MoexQuote = { symbol: string; price: string; quotedAt: Date }
export type MoexClose = { price: string; quotedAt: Date }

type IssResponse = {
  marketdata: { columns: string[]; data: (string | number | null)[][] }
}

type IssHistory = {
  history: { columns: string[]; data: (string | number | null)[][] }
  'history.cursor'?: { data: number[][] }
}

// Страница истории — сто строк, дальше курсор. Три года одной бумаги это
// примерно десять запросов, и делаются они один раз.
const PAGE = 100
// Основная сессия закрывается в 18:45 по Москве: дневная цена получает это
// время, а не полночь, которой на бирже не бывает.
const CLOSE_HOUR = '18:45:00+03:00'

// Число из JSON сразу становится строкой: деньги не должны побывать float по
// дороге. Тот же приём, что в парсере XLSX.
function priceOf(row: Map<string, string | number | null>): string | null {
  for (const field of ['LAST', 'MARKETPRICE', 'PREVPRICE']) {
    const value = row.get(field)
    if (typeof value === 'number' && value > 0) return String(value)
  }
  return null
}

// SYSTIME — время биржи целиком, UPDATETIME — только часы текущего дня.
// Берём SYSTIME: по нему видно, что цена вчерашняя, а не «18:45 неизвестно
// какого числа».
function quotedAt(systime: string | number | null): Date | null {
  if (typeof systime !== 'string') return null
  const [date, time] = systime.split(' ')
  if (!date || !time) return null
  // Время московское, зона в ответе не указана.
  return new Date(`${date}T${time}+03:00`)
}

@Injectable()
export class MoexClient {
  // Каждый запрос к ISS идёт через общий ограничитель и размыкатель: правило
  // проекта, и правило не абстрактное — ISS отвечает 429 на частые обращения,
  // а при второй реплике локальный лимит удваивал бы трафик.
  constructor(private readonly calls: ExternalCall) {}

  // Дневные закрытия: ими заполняется прошлое, которого у пятиминутного
  // опроса нет и быть не может.
  async history(symbol: string, from: Date): Promise<MoexClose[]> {
    const closes: MoexClose[] = []
    let start = 0

    for (;;) {
      const query = new URLSearchParams({
        'iss.meta': 'off',
        'iss.only': 'history,history.cursor',
        'history.columns': 'TRADEDATE,CLOSE,LEGALCLOSEPRICE',
        from: from.toISOString().slice(0, 10),
        start: String(start),
      })
      const url = `${HISTORY}/${BOARD}/securities/${symbol}.json?${query.toString()}`
      const response = await this.calls.run('moex', () => fetch(url))
      if (!response.ok) throw new Error(`MOEX ISS история ответила ${response.status}`)

      const body = (await response.json()) as IssHistory
      const columns = body.history.columns
      for (const row of body.history.data) {
        const fields = new Map(columns.map((name, i) => [name, row[i] ?? null]))
        const date = fields.get('TRADEDATE')
        // LEGALCLOSEPRICE — официальная цена закрытия, CLOSE — последняя
        // сделка сессии. Для оценки портфеля правильнее первая.
        const price = fields.get('LEGALCLOSEPRICE') ?? fields.get('CLOSE')
        if (typeof date !== 'string' || typeof price !== 'number' || price <= 0) continue
        closes.push({ price: String(price), quotedAt: new Date(`${date}T${CLOSE_HOUR}`) })
      }

      const cursor = body['history.cursor']?.data[0]
      const total = cursor?.[1] ?? closes.length
      start += PAGE
      if (!cursor || start >= total) break
    }
    return closes
  }

  async quotes(): Promise<MoexQuote[]> {
    const query = new URLSearchParams({
      'iss.meta': 'off',
      'iss.only': 'marketdata',
      'marketdata.columns': COLUMNS.join(','),
    })
    const response = await this.calls.run('moex', () =>
      fetch(`${BASE}/${BOARD}/securities.json?${query.toString()}`),
    )
    if (!response.ok) throw new Error(`MOEX ISS ответил ${response.status}`)

    const body = (await response.json()) as IssResponse
    const quotes: MoexQuote[] = []

    for (const row of body.marketdata.data) {
      const fields = new Map(body.marketdata.columns.map((name, i) => [name, row[i] ?? null]))
      const symbol = fields.get('SECID')
      const price = priceOf(fields)
      const at = quotedAt(fields.get('SYSTIME') ?? null)
      // Бумага без цены — та, по которой сегодня не торговали и нет прошлой.
      if (typeof symbol !== 'string' || !price || !at) continue
      quotes.push({ symbol, price, quotedAt: at })
    }
    return quotes
  }
}
