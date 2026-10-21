import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router'
import { api } from '../../shared/api/client.ts'
import { useSession } from '../../shared/api/session.tsx'
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

  const symbols = new Map(instruments.data?.map((item) => [item.id, item.symbol]))
  const noAccounts = accounts.isSuccess && accounts.data.length === 0

  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-8">
      <header className="flex items-baseline justify-between">
        <h1 className="font-serif text-xl">Сделки</h1>
        <div className="flex items-baseline gap-4 text-sm">
          <Link to="/trades/new" className="text-accent">
            Записать сделку
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
