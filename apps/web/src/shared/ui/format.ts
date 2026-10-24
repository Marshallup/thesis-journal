// Деньги остаются строками: Intl.NumberFormat.format принимает строку и не
// теряет знаки, а через Number теряет — проверено тестом.
type FormatKind = { fractionDigits: number; maxFractionDigits: number; signed: boolean }

// Рантайм принимает строку и сохраняет все знаки, но в типах TypeScript 7.0.2
// перегрузки со строкой нет. Приведение живёт ровно здесь, дальше по файлу
// тип честный: строка на входе, строка на выходе.
type DecimalFormatter = { format: (value: string) => string }

const cache = new Map<string, DecimalFormatter>()

function formatter({ fractionDigits, maxFractionDigits, signed }: FormatKind): DecimalFormatter {
  const key = `${fractionDigits}/${maxFractionDigits}/${signed}`
  const cached = cache.get(key)
  if (cached) return cached

  const created = new Intl.NumberFormat('ru-RU', {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: maxFractionDigits,
    useGrouping: true,
    // Знак показывается явно, чтобы направление читалось без цвета.
    signDisplay: signed ? 'exceptZero' : 'auto',
  })
  const decimal = created as unknown as DecimalFormatter
  cache.set(key, decimal)
  return decimal
}

export function formatAmount(value: string, kind: FormatKind): string {
  return formatter(kind).format(value)
}

// Ноль по значению, а не по записи: '0', '0.00' и '-0.000' — один и тот же ноль.
export function isZeroAmount(value: string): boolean {
  return /^[+-]?0*(\.0*)?$/.test(value.trim())
}

export function isNegativeAmount(value: string): boolean {
  return value.trim().startsWith('-') && !isZeroAmount(value)
}

// Часовой пояс через Intl, а не прибавлением часов: смещение не константа.
const moscow = new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'Europe/Moscow',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
})

export function formatMoscowTime(iso: string): string {
  return moscow.format(new Date(iso))
}

// Часы с секундами: по живому итогу должно быть видно, что он живой.
const moscowClock = new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'Europe/Moscow',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
})

export function formatMoscowClock(iso: string): string {
  return moscowClock.format(new Date(iso))
}

// График хранит время числом секунд, а не строкой ISO.
export function formatMoscowMoment(at: Date): string {
  return moscow.format(at)
}

// en-CA даёт ровно YYYY-MM-DD — готовый ключ дня по московскому календарю.
const moscowDate = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Moscow',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

export function moscowDay(iso: string): string {
  return moscowDate.format(new Date(iso))
}
