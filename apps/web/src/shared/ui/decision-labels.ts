// Словарь решения. Значения совпадают с тем, что лежит в базе — английские,
// как имена в коде, — а подписи живут здесь и меняются без миграции.
const MOODS: Record<string, string> = {
  calm: 'спокойно',
  thrill: 'азарт',
  fear: 'страх',
  boredom: 'скука',
  fomo: 'упустить',
}

export const MOOD_KEYS = Object.keys(MOODS)

// Неизвестное значение показывается как есть: прочерк соврал бы, что
// настроения не было.
export function moodLabel(mood: string): string {
  return MOODS[mood] ?? mood
}

// Срок на исполнение — про намерение: в эти дни сделка либо случается, либо
// решение остаётся несовершённым. Больше месяца ждать нечего: это уже не
// «собираюсь купить», а «когда-нибудь».
export const EXECUTION_DAYS = [7, 30] as const

// Срок удержания — про позицию, и только у покупки.
export const HOLD_DAYS = [30, 90, 365, 1825] as const

const YEARS: Record<number, string> = { 365: '1 год', 730: '2 года', 1825: '5 лет' }

export function daysLabel(days: number): string {
  return YEARS[days] ?? `${days} дней`
}

export function holdLabel(days: number | null): string {
  return days === null ? 'не указан' : daysLabel(days)
}
