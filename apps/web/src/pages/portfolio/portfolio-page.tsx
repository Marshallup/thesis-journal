import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router'
import { api } from '../../shared/api/client.ts'
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
}

type Totals = {
  realizedPnl: string
  fees: string
  dividends: string
  deposits: string
  net: string
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
        Только то, что посчитано по вашим сделкам: остатки, затраты и реализованный результат.
        Текущих котировок здесь нет, поэтому нет и переоценки — бумага стоит столько, сколько за неё
        заплачено.
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
                  {row.symbol}
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
              <dt>Итого с учётом комиссий</dt>
              <dd className={`tabular ${tone(totals.net)}`}>
                <Money value={totals.net} />
              </dd>
            </div>
          </dl>

          <p className="mt-3 text-ink-muted">
            Реализованный результат считается без комиссий: у импортированных сделок комиссия не
            привязана к сделке и лежит отдельной строкой. Поэтому «итого» — это разница двух строк
            выше, и в комиссии входят в том числе уплаченные за бумаги, которые ещё не проданы.
          </p>
        </section>
      ) : null}
    </main>
  )
}
