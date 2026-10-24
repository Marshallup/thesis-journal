import { Money } from '@thesis/contracts'

// Курс — такая же котировка, как цена бумаги: значение и дата, на которую оно
// верно. Дату приходится тащить до экрана: сумма без курса — мнение, а не
// число, а сумма по вчерашнему курсу — число с другой точностью.
export type FxRate = { value: string; quotedAt: Date }

export type GrandTotal = {
  currency: string
  totalPnl: string
  // null — курса нет вовсе, и единого итога не существует.
  rate: { pair: string; value: string; quotedAt: string; stale: boolean } | null
  // Валюты, которые пересчитать нечем, — их итоги в сумму не вошли. Список, а
  // не флаг: человеку нужно знать, чего именно в числе нет.
  unconverted: string[]
  incomplete: boolean
}

// Валюты, которые считаются долларом. USDT равен доллару только по обещанию
// эмитента: допущение названо вслух и показано на экране рядом с суммой.
const DOLLARS = new Set(['USD', 'USDT', 'USDC'])

export const BASE_CURRENCY = 'RUB'
export const FX_PAIR = 'USDRUB'

// Трое суток, а не одни: ЦБ не публикует курс в выходные и праздники, и порог
// в сутки красил бы устаревшим каждое утро понедельника — метка перестала бы
// что-либо значить. Трое суток переживают выходные, но не сломавшийся забор.
const STALE_AFTER_MS = 3 * 24 * 60 * 60 * 1000

// Складывает итоги по валютам в один, по курсу ЦБ. Без курса единый итог не
// выдумывается: возвращается сумма только базовой валюты и признак неполноты.
export function toSingleTotal(
  totals: Iterable<[string, Money]>,
  rate: FxRate | null,
  now: Date,
): GrandTotal {
  let sum = Money.of('0')
  const unconverted: string[] = []

  for (const [currency, total] of totals) {
    if (currency === BASE_CURRENCY) {
      sum = sum.plus(total)
      continue
    }
    if (rate && DOLLARS.has(currency)) {
      sum = sum.plus(total.times(rate.value))
      continue
    }
    // Валюта, которую пересчитать нечем: сказать об этом, а не промолчать.
    unconverted.push(currency)
  }

  return {
    currency: BASE_CURRENCY,
    totalPnl: sum.toString(),
    rate: rate
      ? {
          pair: FX_PAIR,
          // Через Money: база хранит numeric(28,8), и «80.00000000» на экране
          // читается как точность, которой у курса нет.
          value: Money.of(rate.value).toString(),
          quotedAt: rate.quotedAt.toISOString(),
          stale: now.getTime() - rate.quotedAt.getTime() > STALE_AFTER_MS,
        }
      : null,
    unconverted,
    incomplete: unconverted.length > 0,
  }
}
