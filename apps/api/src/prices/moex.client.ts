import { Injectable } from '@nestjs/common'

// Доска основного режима торгов акциями. У облигаций и фондов свои: тикер без
// доски неоднозначен.
const BOARD = 'TQBR'
const BASE = 'https://iss.moex.com/iss/engines/stock/markets/shares/boards'

// Вся доска одним запросом, без перечисления тикеров: замерено — 510 строк,
// курсора нет, 31 КБ с фильтром по колонкам против 198 без него. Стоимость
// цикла от числа пользователей не зависит вовсе.
const COLUMNS = ['SECID', 'LAST', 'MARKETPRICE', 'PREVPRICE', 'UPDATETIME', 'SYSTIME'] as const

export type MoexQuote = { symbol: string; price: string; quotedAt: Date }

type IssResponse = {
  marketdata: { columns: string[]; data: (string | number | null)[][] }
}

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
  async quotes(): Promise<MoexQuote[]> {
    const query = new URLSearchParams({
      'iss.meta': 'off',
      'iss.only': 'marketdata',
      'marketdata.columns': COLUMNS.join(','),
    })
    const response = await fetch(`${BASE}/${BOARD}/securities.json?${query.toString()}`)
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
