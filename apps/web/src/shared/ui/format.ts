// Деньги приходят строками и остаются строками: Intl.NumberFormat.format
// принимает строку и форматирует её с полной точностью. Через Number то же
// значение теряет знаки — проверено: 12345678901234567890.125 превращается
// в 12345678901234567000.
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
