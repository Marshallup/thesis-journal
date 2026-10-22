import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router'
import { api } from '../../shared/api/client.ts'
import { useSession } from '../../shared/api/session.tsx'
import { accountLabel } from '../../shared/ui/account-label.ts'
import { formatMoscowTime } from '../../shared/ui/format.ts'
import { Money } from '../../shared/ui/money.tsx'

type Trade = {
  id: string
  instrumentId: string
  side: 'buy' | 'sell'
  quantity: string
  price: string
  fee: string
  feeCurrency: string
  executedAt: string
}

type Instrument = { id: string; symbol: string }

type PortfolioAccount = {
  accountId: string
  name: string | null
  provider: string
  kind: string
  baseCurrency: string
  isIis: boolean
  createdAt: string
  realizedPnl: string
  unrealizedPnl: string
  fees: string
  dividends: string
  totalPnl: string
}

type CurrencyTotal = { currency: string; totalPnl: string }

export function TradesPage() {
  const { signOut } = useSession()

  const trades = useQuery({ queryKey: ['trades'], queryFn: () => api<Trade[]>('/trades') })
  const instruments = useQuery({
    queryKey: ['instruments'],
    queryFn: () => api<Instrument[]>('/instruments'),
  })

  const accounts = useQuery({
    queryKey: ['accounts'],
    queryFn: () => api<{ id: string }[]>('/accounts'),
  })
  const portfolio = useQuery({
    queryKey: ['portfolio'],
    queryFn: () => api<{ accounts: PortfolioAccount[]; byCurrency: CurrencyTotal[] }>('/portfolio'),
  })

  const symbols = new Map(instruments.data?.map((item) => [item.id, item.symbol]))
  const noAccounts = accounts.isSuccess && accounts.data.length === 0
  const byAccount = portfolio.data?.accounts ?? []
  const byCurrency = portfolio.data?.byCurrency ?? []
  // Подпись безымянного счёта уточняется только на фоне остальных.
  const labels = byAccount.map((account) => ({ ...account, id: account.accountId }))
  const hasPaper = byAccount.some((account) => account.kind === 'paper')

  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-8">
      <header className="flex items-baseline justify-between">
        <h1 className="font-serif text-xl">Сделки</h1>
        <div className="flex items-baseline gap-4 text-sm">
          <Link to="/trades/new" className="text-accent">
            Записать сделку
          </Link>
          <Link to="/portfolio" className="text-accent">
            Портфель
          </Link>
          <Link to="/trades/unlinked" className="text-accent">
            Без тезиса
          </Link>
          <Link to="/imports" className="text-accent">
            Импорт отчёта
          </Link>
          <Link to="/decisions" className="text-accent">
            Решения
          </Link>
          <Link to="/decisions/new" className="text-accent">
            Записать решение
          </Link>
          <Link to="/accounts/new?next=/" className="text-accent">
            Завести счёт
          </Link>
          <button type="button" onClick={signOut} className="text-accent">
            Выйти
          </button>
        </div>
      </header>

      {byAccount.length > 0 ? (
        <section className="mt-6">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-rule text-ink-muted">
                <th scope="col" className="h-8 text-left font-medium">
                  Счёт
                </th>
                <th scope="col" className="h-8 text-right font-medium">
                  Реализовано
                </th>
                <th scope="col" className="h-8 text-right font-medium">
                  Нереализовано
                </th>
                <th scope="col" className="h-8 text-right font-medium">
                  Комиссии
                </th>
                <th scope="col" className="h-8 text-right font-medium">
                  Дивиденды
                </th>
                <th scope="col" className="h-8 text-right font-medium">
                  Итог
                </th>
              </tr>
            </thead>
            <tbody>
              {byAccount.map((account, i) => (
                <tr key={account.accountId} className="border-b border-rule">
                  <td className="h-8">
                    {accountLabel(labels[i]!, labels)}
                    {account.kind === 'paper' ? (
                      <span className="ml-2 text-xs text-ink-muted">бумажный</span>
                    ) : null}
                  </td>
                  <td className="h-8 text-right">
                    <Money value={account.realizedPnl} signed />
                  </td>
                  <td className="h-8 text-right">
                    <Money value={account.unrealizedPnl} signed />
                  </td>
                  <td className="h-8 text-right">
                    <Money value={account.fees} signed />
                  </td>
                  <td className="h-8 text-right">
                    <Money value={account.dividends} signed />
                  </td>
                  <td className="h-8 text-right">
                    <Money value={account.totalPnl} signed />
                  </td>
                </tr>
              ))}
              {/* Итог на валюту, а не один на всё: доллар к рублю без курса не
                  прибавить, а конвертации в проекте пока нет. */}
              {byCurrency.map((total) => (
                <tr key={total.currency}>
                  <td className="h-8" colSpan={5}>
                    Итого, {total.currency}
                  </td>
                  <td className="h-8 text-right">
                    <Money value={total.totalPnl} signed />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <p className="mt-2 text-xs text-ink-muted">
            Взносы в итог не входят: это принесённые деньги, а не заработок. Нереализованное
            считается по последним котировкам, бумага без цены в него не входит.
            {hasPaper ? ' Бумажные счета помечены и в итог не входят.' : ''}{' '}
            <Link to="/portfolio" className="text-accent">
              Разбор по бумагам
            </Link>
          </p>
        </section>
      ) : null}

      {trades.isPending ? <p className="mt-6 text-sm text-ink-muted">Загружаем</p> : null}

      {trades.isError ? (
        <p role="alert" className="mt-6 text-sm text-loss">
          Не удалось загрузить сделки.
        </p>
      ) : null}

      {noAccounts ? (
        <p className="mt-6 text-sm text-ink-muted">
          Записывать пока некуда: сделка привязывается к счёту.{' '}
          <Link to="/accounts/new" className="text-accent">
            Завести счёт
          </Link>
        </p>
      ) : trades.isSuccess && trades.data.length === 0 ? (
        <p className="mt-6 text-sm text-ink-muted">
          Сделок пока нет. Первая появится здесь сразу после записи.
        </p>
      ) : null}

      {trades.isSuccess && trades.data.length > 0 ? (
        // Регистр, а не карточки: тонкие линейки, числа по правому краю,
        // высота строки 32px.
        <table className="mt-6 w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-rule text-ink-muted">
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
                Комиссия
              </th>
            </tr>
          </thead>
          <tbody>
            {trades.data.map((trade) => (
              <tr key={trade.id} className="border-b border-rule">
                <td className="h-8 tabular">{formatMoscowTime(trade.executedAt)}</td>
                {/* Пока символ не доехал — прочерк, а не часть uuid: обрезанный
                    идентификатор выглядит как данные, но ничего не значит. */}
                <td className="h-8">{symbols.get(trade.instrumentId) ?? '—'}</td>
                <td className="h-8">{trade.side === 'buy' ? 'покупка' : 'продажа'}</td>
                <td className="h-8 text-right">
                  <Money value={trade.quantity} fractionDigits={0} maxFractionDigits={18} />
                </td>
                <td className="h-8 text-right">
                  <Money value={trade.price} />
                </td>
                <td className="h-8 text-right">
                  <Money value={trade.fee} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </main>
  )
}
