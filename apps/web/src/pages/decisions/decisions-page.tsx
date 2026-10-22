import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router'
import { api } from '../../shared/api/client.ts'
import { useSession } from '../../shared/api/session.tsx'
import { formatMoscowTime, isNegativeAmount, isZeroAmount } from '../../shared/ui/format.ts'
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

type Outcome = {
  realizedPnl: string
  unrealizedPnl: string | null
  totalPnl: string | null
  openQuantity: string
  daysLeft: number
}

type Decision = {
  id: string
  thesis: string
  horizonDays: number
  conviction: number
  mood: string
  invalidator: string | null
  unrealized: boolean
  postFactum: boolean
  createdAt: string
  revisions: Revision[]
  trades: LinkedTrade[]
  outcome: Outcome
}

// Решение задним числом написано, когда исход был известен, поэтому в оценку
// качества не входит: иначе дневник хвалил бы себя за угаданное прошлое.
function judged(decisions: Decision[]): Decision[] {
  return decisions.filter((decision) => !decision.postFactum && decision.outcome.totalPnl !== null)
}

function waiting(decision: Decision): boolean {
  return decision.trades.length === 0 && !decision.unrealized && decision.outcome.daysLeft >= 0
}

function expired(decision: Decision): boolean {
  return decision.trades.length === 0 && (decision.unrealized || decision.outcome.daysLeft < 0)
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

      {decisions.data && decisions.data.length > 0 ? (
        <section className="mt-6 border-y border-rule py-3">
          <dl className="flex flex-wrap items-baseline gap-x-8 gap-y-1 text-sm">
            <div className="flex items-baseline gap-2">
              <dt className="text-ink-muted">решений</dt>
              <dd className="tabular">{decisions.data.length}</dd>
            </div>
            <div className="flex items-baseline gap-2">
              <dt className="text-ink-muted">в плюсе</dt>
              <dd className="tabular">
                {
                  judged(decisions.data).filter(
                    (decision) =>
                      !isNegativeAmount(decision.outcome.totalPnl!) &&
                      !isZeroAmount(decision.outcome.totalPnl!),
                  ).length
                }{' '}
                из {judged(decisions.data).length}
              </dd>
            </div>
            <div className="flex items-baseline gap-2">
              <dt className="text-ink-muted">ждут сделки</dt>
              <dd className="tabular">{decisions.data.filter(waiting).length}</dd>
            </div>
            <div className="flex items-baseline gap-2">
              <dt className="text-ink-muted">горизонт истёк без сделки</dt>
              <dd className="tabular">{decisions.data.filter(expired).length}</dd>
            </div>
            <div className="flex items-baseline gap-2">
              <dt className="text-ink-muted">задним числом</dt>
              <dd className="tabular">
                {decisions.data.filter((decision) => decision.postFactum).length}
              </dd>
            </div>
          </dl>
          <p className="mt-2 text-xs text-ink-muted">
            Решения задним числом в оценку не входят: они написаны, когда исход был известен. Итог
            решения считается по лотам, которые открыли и закрыли его сделки, и меняется с каждой
            котировкой.
          </p>
        </section>
      ) : null}

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
            <p className="prose-thesis text-base">
              {current.thesis}
              {decision.postFactum ? (
                <span className="ml-2 text-xs text-ink-muted">записано задним числом</span>
              ) : null}
            </p>

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
                {expired(decision)
                  ? 'горизонт истёк, сделки так и не было'
                  : `сделки пока нет, до конца горизонта ${decision.outcome.daysLeft} дней`}
              </p>
            )}

            {decision.trades.length > 0 ? (
              <dl className="mt-3 flex flex-wrap items-baseline gap-x-6 gap-y-1 text-sm">
                <div className="flex items-baseline gap-2">
                  <dt>итог</dt>
                  <dd>
                    {decision.outcome.totalPnl ? (
                      <Money value={decision.outcome.totalPnl} signed />
                    ) : (
                      '—'
                    )}
                  </dd>
                </div>
                <div className="flex items-baseline gap-2">
                  <dt className="text-ink-muted">реализовано</dt>
                  <dd>
                    <Money value={decision.outcome.realizedPnl} signed />
                  </dd>
                </div>
                {isZeroAmount(decision.outcome.openQuantity) ? null : (
                  <>
                    <div className="flex items-baseline gap-2">
                      <dt className="text-ink-muted">открыто</dt>
                      <dd>
                        <Money
                          value={decision.outcome.openQuantity}
                          fractionDigits={0}
                          maxFractionDigits={18}
                        />{' '}
                        шт
                      </dd>
                    </div>
                    <div className="flex items-baseline gap-2">
                      <dt className="text-ink-muted">нереализовано</dt>
                      <dd>
                        {decision.outcome.unrealizedPnl ? (
                          <Money value={decision.outcome.unrealizedPnl} signed />
                        ) : (
                          '—'
                        )}
                      </dd>
                    </div>
                  </>
                )}
              </dl>
            ) : null}
          </article>
        )
      })}
    </main>
  )
}
