import { formatAmount, isNegativeAmount, isZeroAmount } from './format.ts'

type MoneyProps = {
  // Может не прийти: поле добавили в ответ позже, чем собрали страницу, или
  // сервер отвечает старой версией. Раньше такой случай ронял всю страницу
  // белым экраном — число, которого нет, не повод терять журнал.
  value: string | null | undefined
  // Знак показывается явно там, где он значим: P&L без знака читается неверно.
  signed?: boolean
  fractionDigits?: number
  maxFractionDigits?: number
}

// Единственный компонент, которого нет ни в одной библиотеке. Всегда работает
// со строкой: деньги в number не превращаются даже для показа.
export function Money({
  value,
  signed = false,
  fractionDigits = 2,
  maxFractionDigits = 8,
}: MoneyProps) {
  // Прочерк, а не ноль и не пустота: «неизвестно» и «нисколько» — разные вещи,
  // и путать их в журнале про деньги нельзя.
  if (value === null || value === undefined || value.trim() === '') {
    return <span className="tabular text-ink-muted">—</span>
  }

  // Цвет — вторая подсказка, не первая: он появляется только у величин со
  // знаком, где направление уже прочитано по «+» или «−».
  const tone =
    !signed || isZeroAmount(value)
      ? 'text-ink'
      : isNegativeAmount(value)
        ? 'text-loss'
        : 'text-gain'

  return (
    <span className={`tabular ${tone}`}>
      {formatAmount(value, { fractionDigits, maxFractionDigits, signed })}
    </span>
  )
}
