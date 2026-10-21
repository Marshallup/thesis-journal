import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router'
import { api } from '../../shared/api/client.ts'
import { useSession } from '../../shared/api/session.tsx'
import { formatMoscowTime } from '../../shared/ui/format.ts'
import { Money } from '../../shared/ui/money.tsx'

type Revision = {
  id: string
  thesis: string
  horizonDays: number
  conviction: number
  mood: string
  invalidator: string | null
  createdAt: string
}

type LinkedTrade = {
  id: string
  trade: {
    id: string
    side: 'buy' | 'sell'
    quantity: string
    price: string
    executedAt: string
  }
}

type Decision = {
  id: string
  thesis: string
  horizonDays: number
  conviction: number
  mood: string
  invalidator: string | null
  unrealized: boolean
  createdAt: string
  revisions: Revision[]
  trades: LinkedTrade[]
}

// Действующая редакция — последняя ревизия, если она есть. Исходный текст
// остаётся в истории и никуда не девается: правка его не переписывает.
function effective(decision: Decision) {
  return decision.revisions[0] ?? decision
}

export function DecisionsPage() {
  const { signOut } = useSession()
  const decisions = useQuery({
    queryKey: ['decisions'],
    queryFn: () => api<Decision[]>('/decisions'),
  })

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-8">
      <header className="flex items-baseline justify-between">
        <h1 className="font-serif text-xl">Решения</h1>
        <div className="flex items-baseline gap-4 text-sm">
          <Link to="/" className="text-accent">
            Сделки
          </Link>
          <Link to="/decisions/new" className="text-accent">
            Записать решение
          </Link>
          <button type="button" onClick={signOut} className="text-accent">
            Выйти
          </button>
        </div>
      </header>

      {decisions.isPending ? <p className="mt-6 text-sm text-ink-muted">Загружаем</p> : null}

      {decisions.isError ? (
        <p role="alert" className="mt-6 text-sm text-loss">
          Не удалось загрузить решения.
        </p>
      ) : null}

      {decisions.isSuccess && decisions.data.length === 0 ? (
        <p className="mt-6 text-sm text-ink-muted">
          Решений пока нет. Тезис пишется до сделки — в этом весь смысл.
        </p>
      ) : null}

      {decisions.data?.map((decision) => {
        const current = effective(decision)
        return (
          // Регистр, а не карточка: разделяет линейка, а не тень и радиус.
          <article key={decision.id} className="border-b border-rule py-5">
            <p className="prose-thesis text-base">{current.thesis}</p>

            {/* Подписи словами, а не метаданные через средние точки. */}
            <dl className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-sm text-ink-muted">
              <div className="flex gap-1">
                <dt>горизонт</dt>
                <dd className="tabular text-ink">{current.horizonDays} дней</dd>
              </div>
              <div className="flex gap-1">
                <dt>уверенность</dt>
                <dd className="tabular text-ink">{current.conviction}</dd>
              </div>
              <div className="flex gap-1">
                <dt>настроение</dt>
                <dd className="text-ink">{current.mood}</dd>
              </div>
              <div className="flex gap-1">
                <dt>записано</dt>
                <dd className="tabular text-ink">{formatMoscowTime(decision.createdAt)}</dd>
              </div>
              {decision.revisions.length > 0 ? (
                <div className="flex gap-1">
                  <dt>правок</dt>
                  <dd className="tabular text-ink">{decision.revisions.length}</dd>
                </div>
              ) : null}
            </dl>

            {current.invalidator ? (
              <p className="prose-thesis mt-2 text-sm text-ink-muted">
                неправ, если: {current.invalidator}
              </p>
            ) : null}

            {decision.trades.length > 0 ? (
              <ul className="mt-3 flex flex-col gap-1 text-sm">
                {decision.trades.map(({ id, trade }) => (
                  <li key={id} className="flex items-baseline gap-3">
                    <span className="tabular text-ink-muted">
                      {formatMoscowTime(trade.executedAt)}
                    </span>
                    <span>{trade.side === 'buy' ? 'покупка' : 'продажа'}</span>
                    <Money value={trade.quantity} fractionDigits={0} maxFractionDigits={18} />
                    <span className="text-ink-muted">по</span>
                    <Money value={trade.price} />
                  </li>
                ))}
              </ul>
            ) : (
              // Отсутствие сделки — осмысленное состояние, а не пустота: это
              // либо решение ждёт исполнения, либо горизонт истёк без него.
              <p className="mt-3 text-sm text-ink-muted">
                {decision.unrealized
                  ? 'горизонт истёк, сделки так и не было'
                  : 'сделка ещё не привязана'}
              </p>
            )}
          </article>
        )
      })}
    </main>
  )
}
