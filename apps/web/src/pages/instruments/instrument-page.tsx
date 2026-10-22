import { useQuery } from '@tanstack/react-query'
import { Link, useParams } from 'react-router'
import { api } from '../../shared/api/client.ts'
import { formatMoscowTime } from '../../shared/ui/format.ts'
import { Money } from '../../shared/ui/money.tsx'
import { PriceChart } from './price-chart.tsx'
import type { ChartMarker, ChartPoint } from './price-chart.tsx'

type Trade = {
  id: string
  side: 'buy' | 'sell'
  quantity: string
  price: string
  executedAt: string
}

type Decision = {
  id: string
  instrumentId: string
  side: 'buy' | 'sell'
  thesis: string
  createdAt: string
  postFactum: boolean
}

type PortfolioRow = {
  instrumentId: string
  symbol: string
  quantity: string
  averagePrice: string | null
  price: string | null
  quotedAt: string | null
  unrealizedPnl: string | null
  realizedPnl: string
}

// Изменение цены от последней сделки. Якорь всегда показывается рядом: число
// без него читается как приговор, с ним — как факт.
function changeSince(trade: Trade | undefined, price: string | null): string | null {
  if (!trade || !price) return null
  const from = Number(trade.price)
  if (from === 0) return null
  const percent = ((Number(price) - from) / from) * 100
  return `${percent > 0 ? '+' : ''}${percent.toFixed(1)} %`
}

export function InstrumentPage() {
  const { id = '' } = useParams()

  const prices = useQuery({
    queryKey: ['prices', id],
    queryFn: () => api<ChartPoint[]>(`/prices/${id}`),
  })
  const trades = useQuery({
    queryKey: ['trades', id],
    queryFn: () => api<Trade[]>(`/trades?instrumentId=${id}`),
  })
  const decisions = useQuery({
    queryKey: ['decisions'],
    queryFn: () => api<Decision[]>('/decisions'),
  })
  const portfolio = useQuery({
    queryKey: ['portfolio'],
    queryFn: () => api<{ rows: PortfolioRow[] }>('/portfolio'),
  })

  const row = portfolio.data?.rows.find((item) => item.instrumentId === id)
  const ownDecisions = decisions.data?.filter((item) => item.instrumentId === id) ?? []
  const lastTrade = trades.data?.[0]
  const change = changeSince(lastTrade, row?.price ?? null)

  const markers: ChartMarker[] = [
    ...(trades.data ?? []).map((trade) => ({
      at: trade.executedAt,
      side: trade.side,
      kind: 'trade' as const,
      text: `${trade.side === 'buy' ? 'куп' : 'прод'} ${Number(trade.quantity)}`,
    })),
    ...ownDecisions.map((decision) => ({
      at: decision.createdAt,
      side: decision.side,
      kind: 'decision' as const,
      text: decision.thesis.slice(0, 24),
    })),
  ]

  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-8">
      <header className="flex items-baseline justify-between">
        <h1 className="font-serif text-xl">{row?.symbol ?? 'Инструмент'}</h1>
        <div className="flex items-baseline gap-4 text-sm">
          <Link to="/portfolio" className="text-accent">
            Портфель
          </Link>
          <Link to="/" className="text-accent">
            Сделки
          </Link>
        </div>
      </header>

      <p className="mt-1 text-sm text-ink-muted">
        Цена, ваши сделки и решения на одной линии: видно, где вы решили, где вошли и что было
        дальше.
      </p>

      {prices.isSuccess && prices.data.length === 0 ? (
        <p className="mt-6 text-sm text-ink-muted">
          Цен по этой бумаге пока нет: котировки подтягиваются с Московской биржи каждые несколько
          минут и накапливаются с первого запуска.
        </p>
      ) : null}

      {prices.isSuccess && prices.data.length > 0 ? (
        <PriceChart
          points={prices.data}
          markers={markers}
          averagePrice={row?.averagePrice ?? null}
        />
      ) : null}

      <dl className="mt-6 flex flex-col gap-1 border-t border-rule pt-4 text-sm">
        {row?.price ? (
          <div className="flex justify-between">
            <dt className="text-ink-muted">Цена</dt>
            <dd className="tabular">
              <Money value={row.price} />
              {row.quotedAt ? (
                <span className="ml-2 text-xs text-ink-muted">
                  {formatMoscowTime(row.quotedAt)}
                </span>
              ) : null}
            </dd>
          </div>
        ) : null}

        {lastTrade ? (
          <div className="flex justify-between">
            <dt className="text-ink-muted">
              Последняя сделка: {lastTrade.side === 'buy' ? 'покупка' : 'продажа'}{' '}
              {Number(lastTrade.quantity)} по <Money value={lastTrade.price} /> ·{' '}
              {formatMoscowTime(lastTrade.executedAt)}
            </dt>
            <dd
              className={`tabular ${change?.startsWith('-') ? 'text-loss' : change ? 'text-gain' : ''}`}
            >
              {change ? `с тех пор ${change}` : '—'}
            </dd>
          </div>
        ) : null}

        {row?.unrealizedPnl ? (
          <div className="flex justify-between">
            <dt className="text-ink-muted">Нереализовано по открытым лотам</dt>
            <dd
              className={`tabular ${row.unrealizedPnl.startsWith('-') ? 'text-loss' : 'text-gain'}`}
            >
              <Money value={row.unrealizedPnl} />
            </dd>
          </div>
        ) : null}
      </dl>

      {ownDecisions.length > 0 ? (
        <section className="mt-8">
          <h2 className="font-serif text-lg">Решения по этой бумаге</h2>
          <table className="mt-3 w-full border-collapse text-sm">
            <tbody>
              {ownDecisions.map((decision) => (
                <tr key={decision.id} className="border-b border-rule align-top">
                  <td className="h-8 w-32 tabular text-ink-muted">
                    {formatMoscowTime(decision.createdAt)}
                  </td>
                  <td className="h-8 w-20">{decision.side === 'buy' ? 'покупка' : 'продажа'}</td>
                  <td className="h-8">
                    {decision.thesis}
                    {decision.postFactum ? (
                      <span className="ml-2 text-xs text-ink-muted">записано задним числом</span>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}
    </main>
  )
}
