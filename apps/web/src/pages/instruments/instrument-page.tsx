import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import { Link, useParams } from 'react-router'
import { api } from '../../shared/api/client.ts'
import { formatAmount, formatMoscowTime, moscowDay } from '../../shared/ui/format.ts'
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

const DAY_MS = 24 * 60 * 60 * 1000
const MIN_DAYS = 90
const MARGIN_DAYS = 30
// Потолок окна в контракте API: больше десяти лет не спрашиваем.
const MAX_DAYS = 3650
const QUANTITY = { fractionDigits: 0, maxFractionDigits: 18, signed: false }

// Окно графика — на месяц раньше первой сделки. С окном по умолчанию все
// отметки старше трёх месяцев оказываются левее первой известной цены, и
// график честно показывает их нигде.
function windowDays(trades: Trade[]): number {
  // Список приходит от новых к старым.
  const first = trades.at(-1)
  if (!first) return MIN_DAYS
  const since = Math.ceil((Date.now() - Date.parse(first.executedAt)) / DAY_MS)
  return Math.min(MAX_DAYS, Math.max(MIN_DAYS, since + MARGIN_DAYS))
}

// Сделки одного дня и одной стороны — одна отметка: у дневной цены нет часов,
// и семь продаж подряд рисуются одна поверх другой. Там, где сделка одна,
// в подписи остаётся количество; где их несколько — их число: складывать
// количества на фронте нечем, Money живёт на бэкенде.
function tradeMarkers(trades: Trade[]): ChartMarker[] {
  const byDay = new Map<
    string,
    { at: string; side: 'buy' | 'sell'; quantity: string; count: number }
  >()

  for (const trade of trades) {
    const key = `${moscowDay(trade.executedAt)} ${trade.side}`
    const group = byDay.get(key)
    if (!group) {
      byDay.set(key, {
        at: trade.executedAt,
        side: trade.side,
        quantity: trade.quantity,
        count: 1,
      })
      continue
    }
    group.count += 1
    // Отметка встаёт на первую сделку дня: по ней видно, когда человек начал.
    if (trade.executedAt < group.at) group.at = trade.executedAt
  }

  return [...byDay.values()].map((group) => ({
    at: group.at,
    side: group.side,
    kind: 'trade' as const,
    text: `${group.side === 'buy' ? 'куп' : 'прод'} ${
      group.count === 1 ? formatAmount(group.quantity, QUANTITY) : `×${group.count}`
    }`,
  }))
}

export function InstrumentPage() {
  const { id = '' } = useParams()

  const trades = useQuery({
    queryKey: ['trades', id],
    queryFn: () => api<Trade[]>(`/trades?instrumentId=${id}`),
  })
  // Цены ждут сделок: окно считается по самой старой из них.
  const days = windowDays(trades.data ?? [])
  const prices = useQuery({
    queryKey: ['prices', id, days],
    queryFn: () => api<ChartPoint[]>(`/prices/${id}?days=${days}`),
    enabled: trades.isSuccess,
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
  // Массивы считаются через useMemo: новый массив на каждый рендер — это новая
  // ссылка, и график перерисовывал бы данные без причины.
  const ownDecisions = useMemo(
    () => decisions.data?.filter((item) => item.instrumentId === id) ?? [],
    [decisions.data, id],
  )
  const lastTrade = trades.data?.[0]
  const change = changeSince(lastTrade, row?.price ?? null)

  const markers = useMemo<ChartMarker[]>(
    () => [
      ...tradeMarkers(trades.data ?? []),
      // Тезис целиком лежит в списке под графиком: на оси он перекрывал
      // подписи сделок и читался хуже, чем нигде.
      ...ownDecisions.map((decision) => ({
        at: decision.createdAt,
        side: decision.side,
        kind: 'decision' as const,
        text: 'тезис',
      })),
    ],
    [trades.data, ownDecisions],
  )

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
              <Money value={lastTrade.quantity} fractionDigits={0} maxFractionDigits={18} /> по{' '}
              <Money value={lastTrade.price} /> · {formatMoscowTime(lastTrade.executedAt)}
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
