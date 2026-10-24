import { Injectable } from '@nestjs/common'
import { Money } from '@thesis/contracts'
import { ExternalCall } from '../outbound/external-call.ts'

// Официальный курс ЦБ: XML без ключа и без ограничений. Он же — единственный
// источник, который можно назвать вслух в документе: «по курсу ЦБ на такую-то
// дату» понятно всем, а «по курсу биржи X на момент Y» требует объяснений.
const DAILY = 'https://www.cbr.ru/scripts/XML_daily.asp'
const TIMEOUT_MS = 10_000

// Курс публикуется на рабочий день и действует со следующего. Берём то, что
// отдаёт ЦБ на сегодня: в выходные это курс пятницы, и это правильно.
const USD = 'R01235'

@Injectable()
export class CbrClient {
  constructor(private readonly calls: ExternalCall) {}

  // Рублей за доллар. Разбор без библиотеки: документ крошечный и формат
  // фиксирован двадцать лет, а XML-парсер ради одного значения — зависимость
  // без причины. Регулярка узкая и привязана к идентификатору валюты, а не к
  // порядку тегов.
  async usdRub(): Promise<{ price: string; quotedAt: Date } | null> {
    const response = await this.calls.run('cbr', () =>
      fetch(DAILY, { signal: AbortSignal.timeout(TIMEOUT_MS) }),
    )
    if (!response.ok) throw new Error(`ЦБ ответил ${response.status}`)

    // Документ в windows-1251: читаем байтами и декодируем явно, иначе вместо
    // кириллицы приедут вопросительные знаки. На числа это не влияет, но
    // молча портить текст нельзя.
    const text = new TextDecoder('windows-1251').decode(await response.arrayBuffer())

    const valute = new RegExp(`<Valute ID="${USD}">([\\s\\S]*?)</Valute>`).exec(text)?.[1]
    if (!valute) return null

    const nominal = /<Nominal>(\d+)<\/Nominal>/.exec(valute)?.[1]
    // Запятая, а не точка: ЦБ пишет по-русски.
    const value = /<Value>([\d,]+)<\/Value>/.exec(valute)?.[1]?.replace(',', '.')
    const date = /Date="(\d{2})\.(\d{2})\.(\d{4})"/.exec(text)
    if (!nominal || !value || !date) return null

    return {
      // Номинал бывает больше единицы у слабых валют: у доллара это всегда 1,
      // но делить надо всё равно — иначе однажды приедет курс за сто единиц.
      price: Money.of(value).div(nominal).toString(),
      // Курс относится к дню целиком, временем ставится его конец — как у
      // дневных закрытий бирж.
      quotedAt: new Date(`${date[3]}-${date[2]}-${date[1]}T23:59:59.000Z`),
    }
  }
}
