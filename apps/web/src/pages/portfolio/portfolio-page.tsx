import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router'
import { api } from '../../shared/api/client.ts'
import { formatMoscowTime } from '../../shared/ui/format.ts'
import { Money } from '../../shared/ui/money.tsx'

type Row = {
  instrumentId: string
  symbol: string
  quantity: string
  costBasisTotal: string
  averagePrice: string | null
  realizedPnl: string
  fees: string
  incomplete: boolean
  price: string | null
  quotedAt: string | null
  value: string | null
  unrealizedPnl: string | null
}

type Totals = {
  value: string
  unrealizedPnl: string
  realizedPnl: string
  fees: string
  dividends: string
  deposits: string
  totalPnl: string
}

// Знак читается без цвета: минус стоит в самом числе, цвет — вторая подсказка.
function tone(value: string): string {
  if (value.startsWith('-')) return 'text-loss'
  return Number(value) > 0 ? 'text-gain' : ''
}

export function PortfolioPage() {
  const portfolio = useQuery({
    queryKey: ['portfolio'],
    queryFn: () => api<{ rows: Row[]; totals: Totals }>('/portfolio'),
  })

  const rows = portfolio.data?.rows ?? []
  const totals = portfolio.data?.totals

  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-8">
      <header className="flex items-baseline justify-between">
        <h1 className="font-serif text-xl">Портфель</h1>
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
        Остатки и затраты посчитаны по вашим сделкам, цены приходят с Московской биржи с задержкой
        около пятнадцати минут. Бумага без цены показана прочерком и в стоимость портфеля не входит.
      </p>

      {portfolio.isPending ? <p className="mt-6 text-sm text-ink-muted">Загружаем</p> : null}

      {portfolio.isSuccess && rows.length === 0 ? (
        <p className="mt-6 text-sm text-ink-muted">
          Пока пусто. Запишите сделку руками или{' '}
          <Link to="/imports" className="text-accent">
            залейте отчёт брокера
          </Link>
          .
        </p>
      ) : null}

      {rows.length > 0 ? (
        <table className="mt-6 w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-rule text-ink-muted">
              <th scope="col" className="h-8 text-left font-medium">
                Бумага
              </th>
              <th scope="col" className="h-8 text-right font-medium">
                Остаток
              </th>
              <th scope="col" className="h-8 text-right font-medium">
                Средняя цена
              </th>
              <th scope="col" className="h-8 text-right font-medium">
                Затраты
              </th>
              <th scope="col" className="h-8 text-right font-medium">
                Цена
              </th>
              <th scope="col" className="h-8 text-right font-medium">
                Стоимость
              </th>
              <th scope="col" className="h-8 text-right font-medium">
                Нереализовано
              </th>
              <th scope="col" className="h-8 text-right font-medium">
                Реализовано
              </th>
              <th scope="col" className="h-8 text-right font-medium">
                Комиссии
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.instrumentId} className="border-b border-rule">
                <td className="h-8">
                  <Link to={`/instruments/${row.instrumentId}`} className="text-accent">
                    {row.symbol}
                  </Link>
                  {row.incomplete ? (
                    // Пометка, а не молчание: по этой бумаге есть продажи,
                    // которые ждут покупок, и любые числа в строке неполны.
                    <Link to="/imports" className="ml-2 text-xs text-loss">
                      неполная: есть отложенные продажи
                    </Link>
                  ) : null}
                </td>
                <td className="h-8 text-right">
                  <Money value={row.quantity} fractionDigits={0} maxFractionDigits={18} />
                </td>
                <td className="h-8 text-right">
                  {row.averagePrice ? <Money value={row.averagePrice} /> : '—'}
                </td>
                <td className="h-8 text-right">
                  <Money value={row.costBasisTotal} />
                </td>
                <td className="h-8 text-right">
                  {row.price ? (
                    <>
                      <Money value={row.price} />
                      {/* Время котировки рядом с числом: важно не только
                          сколько, но и когда. */}
                      {row.quotedAt ? (
                        <span className="ml-2 text-xs text-ink-muted">
                          {formatMoscowTime(row.quotedAt)}
                        </span>
                      ) : null}
                    </>
                  ) : (
                    '—'
                  )}
                </td>
                <td className="h-8 text-right">{row.value ? <Money value={row.value} /> : '—'}</td>
                <td
                  className={`h-8 text-right ${row.unrealizedPnl ? tone(row.unrealizedPnl) : ''}`}
                >
                  {row.unrealizedPnl ? <Money value={row.unrealizedPnl} /> : '—'}
                </td>
                <td className={`h-8 text-right ${tone(row.realizedPnl)}`}>
                  <Money value={row.realizedPnl} />
                </td>
                <td className={`h-8 text-right ${tone(row.fees)}`}>
                  <Money value={row.fees} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}

      {totals ? (
        <section className="mt-8 border-t border-rule pt-4 text-sm">
          <dl className="flex flex-col gap-1">
            <div className="flex justify-between">
              <dt className="text-ink-muted">Стоимость бумаг с ценой</dt>
              <dd className="tabular">
                <Money value={totals.value} />
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-ink-muted">Нереализовано</dt>
              <dd className={`tabular ${tone(totals.unrealizedPnl)}`}>
                <Money value={totals.unrealizedPnl} />
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-ink-muted">Реализовано по сделкам</dt>
              <dd className={`tabular ${tone(totals.realizedPnl)}`}>
                <Money value={totals.realizedPnl} />
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-ink-muted">Комиссии</dt>
              <dd className={`tabular ${tone(totals.fees)}`}>
                <Money value={totals.fees} />
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-ink-muted">Дивиденды</dt>
              <dd className="tabular">
                <Money value={totals.dividends} />
              </dd>
            </div>
            <div className="flex justify-between border-t border-rule pt-1">
              <dt>Итог по всем счетам</dt>
              <dd className={`tabular ${tone(totals.totalPnl)}`}>
                <Money value={totals.totalPnl} />
              </dd>
            </div>
          </dl>

          <p className="mt-3 text-ink-muted">
            Итог — сумма всех строк выше, кроме взносов: комиссии и дивиденды входят со своим
            знаком. Реализованный результат при этом считается без комиссий — у импортированных
            сделок комиссия к сделке не привязана и лежит отдельной строкой, в том числе уплаченная
            за бумаги, которые ещё не проданы.
          </p>
        </section>
      ) : null}
    </main>
  )
}
