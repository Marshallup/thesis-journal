import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Link } from 'react-router'
import { api } from '../../shared/api/client.ts'
import { formatMoscowTime } from '../../shared/ui/format.ts'
import { Money } from '../../shared/ui/money.tsx'

type Trade = {
  id: string
  accountId: string
  instrumentId: string
  side: 'buy' | 'sell'
  quantity: string
  price: string
  executedAt: string
}

type Decision = {
  id: string
  accountId: string
  instrumentId: string
  side: 'buy' | 'sell'
  thesis: string
  createdAt: string
  postFactum: boolean
}

type Instrument = { id: string; symbol: string }

// Решение задним числом заводится на конкретную сделку, поэтому форма
// открывается уже заполненной: счёт, бумага и сторона берутся из неё.
function postFactumLink(trade: Trade): string {
  const query = new URLSearchParams({
    accountId: trade.accountId,
    instrumentId: trade.instrumentId,
    side: trade.side,
    postFactum: '1',
    next: '/trades/unlinked',
  })
  return `/decisions/new?${query.toString()}`
}

// Решение исполняется сделкой того же счёта, той же бумаги и той же стороны —
// то же правило, что проверяет сервер. Проверять его и здесь нужно не ради
// безопасности, а чтобы не предлагать человеку заведомо отказной выбор.
function suitable(decisions: Decision[], trades: Trade[]): Decision[] {
  const first = trades[0]
  if (!first) return []
  return decisions.filter(
    (decision) =>
      trades.every(
        (trade) =>
          trade.accountId === decision.accountId &&
          trade.instrumentId === decision.instrumentId &&
          trade.side === decision.side,
      ) && !decision.postFactum,
  )
}

export function UnlinkedTradesPage() {
  const queryClient = useQueryClient()

  const trades = useQuery({
    queryKey: ['trades', 'unlinked'],
    queryFn: () => api<Trade[]>('/trades?linked=false'),
  })
  const decisions = useQuery({
    queryKey: ['decisions'],
    queryFn: () => api<Decision[]>('/decisions'),
  })
  const instruments = useQuery({
    queryKey: ['instruments'],
    queryFn: () => api<Instrument[]>('/instruments'),
  })

  const [selected, setSelected] = useState<string[]>([])
  const [decisionId, setDecisionId] = useState('')

  const symbols = new Map(instruments.data?.map((item) => [item.id, item.symbol]))
  const chosen = trades.data?.filter((trade) => selected.includes(trade.id)) ?? []
  const candidates = suitable(decisions.data ?? [], chosen)

  const link = useMutation({
    mutationFn: () =>
      api<{ linked: number; skipped: number }>(`/decisions/${decisionId}/trades`, {
        method: 'POST',
        body: JSON.stringify({ tradeIds: selected }),
      }),
    onSuccess: async () => {
      setSelected([])
      setDecisionId('')
      await queryClient.invalidateQueries({ queryKey: ['trades'] })
      await queryClient.invalidateQueries({ queryKey: ['decisions'] })
    },
  })

  const toggle = (id: string) => {
    setSelected((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
    )
    setDecisionId('')
  }

  return (
    <main className="mx-auto w-full max-w-4xl px-4 py-8">
      <header className="flex items-baseline justify-between">
        <h1 className="font-serif text-xl">Сделки без тезиса</h1>
        <div className="flex items-baseline gap-4 text-sm">
          <Link to="/" className="text-accent">
            Сделки
          </Link>
          <Link to="/imports" className="text-accent">
            Импорт отчёта
          </Link>
        </div>
      </header>
      <p className="mt-1 text-sm text-ink-muted">
        Импорт приносит факты, а не причины. Привяжите сделку к решению, которое её объясняет, — или
        запишите решение задним числом, честно пометив его таким.
      </p>

      {trades.isSuccess && trades.data.length === 0 ? (
        <p className="mt-6 text-sm text-ink-muted">
          Все сделки размечены. Это редкое и приятное состояние.
        </p>
      ) : null}

      {trades.isSuccess && trades.data.length > 0 ? (
        <table className="mt-6 w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-rule text-ink-muted">
              <th scope="col" className="h-8 w-8 text-left font-medium">
                <span className="sr-only">Выбор</span>
              </th>
              <th scope="col" className="h-8 text-left font-medium">
                Дата, МСК
              </th>
              <th scope="col" className="h-8 text-left font-medium">
                Инструмент
              </th>
              <th scope="col" className="h-8 text-left font-medium">
                Сторона
              </th>
              <th scope="col" className="h-8 text-right font-medium">
                Количество
              </th>
              <th scope="col" className="h-8 text-right font-medium">
                Цена
              </th>
              <th scope="col" className="h-8 text-right font-medium">
                Тезис
              </th>
            </tr>
          </thead>
          <tbody>
            {trades.data.map((trade) => (
              <tr key={trade.id} className="border-b border-rule">
                <td className="h-8">
                  <input
                    type="checkbox"
                    checked={selected.includes(trade.id)}
                    onChange={() => toggle(trade.id)}
                    aria-label={`Выбрать сделку от ${formatMoscowTime(trade.executedAt)}`}
                  />
                </td>
                <td className="h-8 tabular">{formatMoscowTime(trade.executedAt)}</td>
                <td className="h-8">{symbols.get(trade.instrumentId) ?? '—'}</td>
                <td className="h-8">{trade.side === 'buy' ? 'покупка' : 'продажа'}</td>
                <td className="h-8 text-right">
                  <Money value={trade.quantity} fractionDigits={0} maxFractionDigits={18} />
                </td>
                <td className="h-8 text-right">
                  <Money value={trade.price} />
                </td>
                <td className="h-8 text-right">
                  <Link to={postFactumLink(trade)} className="text-accent">
                    записать задним числом
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}

      {/* Привязка появляется только когда есть что привязывать: пустая панель
          внизу экрана — это шум. */}
      {selected.length > 0 ? (
        <form
          className="mt-6 flex flex-wrap items-end gap-3 border-t border-rule pt-4"
          onSubmit={(event) => {
            event.preventDefault()
            link.mutate()
          }}
        >
          <label className="flex flex-1 flex-col gap-1">
            <span className="text-sm text-ink-muted">
              Решение для выбранных сделок ({selected.length})
            </span>
            <select
              value={decisionId}
              onChange={(event) => setDecisionId(event.target.value)}
              required
              className="rounded-sm border border-rule bg-surface px-2 py-1.5"
            >
              <option value="">выберите</option>
              {candidates.map((decision) => (
                <option key={decision.id} value={decision.id}>
                  {formatMoscowTime(decision.createdAt)} — {decision.thesis.slice(0, 60)}
                </option>
              ))}
            </select>
          </label>
          <button
            type="submit"
            disabled={decisionId === '' || link.isPending}
            className="rounded-sm border border-rule px-3 py-1.5 text-sm disabled:text-ink-muted"
          >
            {link.isPending ? 'Привязываем' : 'Привязать'}
          </button>
        </form>
      ) : null}

      <div aria-live="polite" className="mt-4 text-sm">
        {selected.length > 0 && candidates.length === 0 ? (
          <p className="text-ink-muted">
            Подходящих решений нет: решение исполняется сделкой того же счёта, той же бумаги и той
            же стороны. Если выбрано несколько сделок, они должны совпадать между собой.{' '}
            <Link to="/decisions/new" className="text-accent">
              Записать решение
            </Link>
          </p>
        ) : null}
        {link.isSuccess ? (
          <p className="tabular">
            Привязано {link.data.linked}, уже было привязано {link.data.skipped}
          </p>
        ) : null}
        {link.isError ? (
          <p role="alert" className="text-loss">
            {link.error.message}
          </p>
        ) : null}
      </div>
    </main>
  )
}
