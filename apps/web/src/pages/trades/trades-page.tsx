import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { Link } from 'react-router'
import { api } from '../../shared/api/client.ts'
import { useSession } from '../../shared/api/session.tsx'
import { accountLabel } from '../../shared/ui/account-label.ts'
import type { LabelledAccount } from '../../shared/ui/account-label.ts'
import { formatMoscowTime } from '../../shared/ui/format.ts'
import { Money } from '../../shared/ui/money.tsx'

type Trade = {
  id: string
  accountId: string
  instrumentId: string
  side: 'buy' | 'sell'
  // Монета пришла не покупкой: депозит, airdrop, конвертация. В журнале это
  // лот с нулевой себестоимостью, и на экране он обязан выглядеть иначе, чем
  // покупка — иначе читается как «купил по нулю».
  costUnknown?: boolean
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
  unpricedPositions: number
  realizedWithoutCost?: string
  derivativeRows?: number
  fees: string
  dividends: string
  totalPnl: string
}

type CurrencyTotal = { currency: string; totalPnl: string; incomplete: boolean }

// Решения без сделок: ровно то, чего не показывает ни один брокер — он знает
// только совершённое.
type Decision = { id: string; unrealized: boolean; trades: unknown[] }

export function TradesPage() {
  const { signOut } = useSession()

  // Фильтр по счёту: два счёта одного брокера различаются только хвостом
  // идентификатора, и сделки по одной бумаге на них выглядят дублями.
  const [accountId, setAccountId] = useState('')
  const trades = useQuery({
    queryKey: ['trades', accountId],
    queryFn: () => api<Trade[]>(accountId ? `/trades?accountId=${accountId}` : '/trades'),
  })
  const instruments = useQuery({
    queryKey: ['instruments'],
    queryFn: () => api<Instrument[]>('/instruments'),
  })

  const accounts = useQuery({
    queryKey: ['accounts'],
    queryFn: () => api<LabelledAccount[]>('/accounts'),
  })
  const portfolio = useQuery({
    queryKey: ['portfolio'],
    queryFn: () => api<{ accounts: PortfolioAccount[]; byCurrency: CurrencyTotal[] }>('/portfolio'),
  })

  const symbols = new Map(instruments.data?.map((item) => [item.id, item.symbol]))
  const noAccounts = accounts.isSuccess && accounts.data.length === 0
  const decisions = useQuery({
    queryKey: ['decisions'],
    queryFn: () => api<Decision[]>('/decisions'),
  })
  const idle = (decisions.data ?? []).filter(
    (decision) => decision.unrealized && decision.trades.length === 0,
  ).length

  // Подписи счетов одни и те же в обеих таблицах: иначе «Сбер · #4e09» вверху
  // и «Сбер» внизу читались бы как разные счета.
  const accountNames = new Map(
    (accounts.data ?? []).map((account) => [
      account.id,
      accountLabel(account, accounts.data ?? []),
    ]),
  )

  const byAccount = portfolio.data?.accounts ?? []
  const byCurrency = portfolio.data?.byCurrency ?? []
  const unpriced = byAccount.reduce((sum, account) => sum + account.unpricedPositions, 0)
  // Проверка на наличие, а не только на «не ноль»: поля может не быть вовсе,
  // если сервер отвечает версией старше страницы.
  const derivatives = byAccount.reduce((sum, account) => sum + (account.derivativeRows ?? 0), 0)
  const withoutCost = byAccount.filter(
    (account) => account.realizedWithoutCost && account.realizedWithoutCost !== '0',
  )
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
          <Link to="/exchange" className="text-accent">
            Биржа
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
                    {account.realizedWithoutCost && account.realizedWithoutCost !== '0' ? (
                      <sup>†</sup>
                    ) : null}
                  </td>
                  {/* Прочерк, а не ноль: если ни по одной открытой позиции нет
                      цены, нереализованного не «нисколько» — оно неизвестно.
                      Звёздочка там, где цена есть лишь по части бумаг. */}
                  <td className="h-8 text-right">
                    {account.unpricedPositions > 0 && account.unrealizedPnl === '0' ? (
                      <span title="нет цен по открытым позициям">—</span>
                    ) : (
                      <>
                        <Money value={account.unrealizedPnl} signed />
                        {account.unpricedPositions > 0 ? <sup>*</sup> : null}
                      </>
                    )}
                  </td>
                  <td className="h-8 text-right">
                    <Money value={account.fees} signed />
                  </td>
                  <td className="h-8 text-right">
                    <Money value={account.dividends} signed />
                  </td>
                  <td className="h-8 text-right">
                    <Money value={account.totalPnl} signed />
                    {account.unpricedPositions > 0 ? <sup>*</sup> : null}
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
                    {total.incomplete ? <sup>*</sup> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {idle > 0 ? (
            <p className="mt-2 text-sm">
              Решений, у которых срок на исполнение прошёл без сделки:{' '}
              <span className="tabular">{idle}</span>.{' '}
              <Link to="/decisions" className="text-accent">
                Посмотреть
              </Link>
            </p>
          ) : null}

          {withoutCost.length > 0 ? (
            // Прибыль по монете, пришедшей не покупкой, завышена на всю её
            // стоимость: себестоимости у неё нет, и журнал считает её
            // бесплатной. Без этой строки число выглядит заработком.
            <p className="mt-2 text-sm">
              † Из реализованного получено по монетам, пришедшим не покупкой:{' '}
              {withoutCost.map((account, i) => (
                <span key={account.accountId}>
                  {i > 0 ? ', ' : ''}
                  <Money value={account.realizedWithoutCost} signed /> {account.baseCurrency}
                </span>
              ))}
              . Это депозиты, airdrop'ы и конвертации: их себестоимость оценена по цене на момент
              зачисления, а не взята из сделки. Там, где биржа пары не знает, она нулевая — и
              прибыль завышена на всю стоимость монеты.
            </p>
          ) : null}

          {derivatives > 0 ? (
            // Решение «фьючерсы не считаем» принято сознательно, но счёт,
            // где ими торговали, обязан сказать, что его итог — не про все
            // деньги: позиция с плечом, фондирование и ликвидации в лотовую
            // модель не ложатся.
            <p className="mt-2 text-sm">
              В выгрузках этого счёта было{' '}
              <span className="tabular">{derivatives.toLocaleString('ru')}</span> строк с
              фьючерсами. Журнал их не учитывает: позиция с плечом, фондирование и ликвидации не
              описываются лотами, и в итог они не входят.
            </p>
          ) : null}

          <p className="mt-2 text-xs text-ink-muted">
            Взносы в итог не входят: это принесённые деньги, а не заработок. Нереализованное
            считается по последним котировкам.
            {unpriced > 0
              ? ` * Открытых позиций без цены: ${unpriced}. Это бумаги и пары, по которым котировок
                 нет: делистинг, переименование или торгов не было вовсе. В нереализованное и в
                 итог они не входят — не потому, что равны нулю, а потому что цена неизвестна.`
              : ' Бумага без цены в него не входит.'}
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

      {accounts.data && accounts.data.length > 1 ? (
        // Появляется только когда счетов больше одного: единственный счёт
        // фильтровать не от чего, а лишний контрол — шум.
        <label className="mt-6 flex items-baseline gap-2 text-sm">
          <span className="text-ink-muted">Счёт</span>
          <select
            value={accountId}
            onChange={(event) => setAccountId(event.target.value)}
            className="rounded-sm border border-rule bg-surface px-2 py-1"
          >
            <option value="">все счета</option>
            {accounts.data.map((account) => (
              <option key={account.id} value={account.id}>
                {accountLabel(account, accounts.data ?? [])}
              </option>
            ))}
          </select>
        </label>
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
              {/* Счёт в строке, а не только в фильтре: при двух счетах одного
                  брокера иначе непонятно, к чему относится сделка. */}
              <th scope="col" className="h-8 text-left font-medium">
                Счёт
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
                <td className="h-8 text-ink-muted">{accountNames.get(trade.accountId) ?? '—'}</td>
                {/* Пока символ не доехал — прочерк, а не часть uuid: обрезанный
                    идентификатор выглядит как данные, но ничего не значит. */}
                <td className="h-8">{symbols.get(trade.instrumentId) ?? '—'}</td>
                <td className="h-8">
                  {trade.costUnknown
                    ? trade.side === 'buy'
                      ? 'приход'
                      : 'вывод'
                    : trade.side === 'buy'
                      ? 'покупка'
                      : 'продажа'}
                </td>
                <td className="h-8 text-right">
                  <Money value={trade.quantity} fractionDigits={0} maxFractionDigits={18} />
                </td>
                <td className="h-8 text-right">
                  {/* У прихода цены нет вовсе, а ноль читался бы как «досталось
                      бесплатно» — это разные вещи. */}
                  {trade.costUnknown && trade.price === '0' ? (
                    <span className="text-ink-muted" title="себестоимость неизвестна">
                      —
                    </span>
                  ) : (
                    <>
                      <Money value={trade.price} />
                      {trade.costUnknown ? (
                        <span className="text-ink-muted" title="оценка по цене на момент прихода">
                          {' ≈'}
                        </span>
                      ) : null}
                    </>
                  )}
                </td>
                <td className="h-8 text-right">
                  <Money value={trade.fee} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}

      {trades.data?.some((trade) => trade.costUnknown) ? (
        <p className="mt-2 text-xs text-ink-muted">
          «Приход» — монета пришла не покупкой: депозит из сети, airdrop, конвертация токена.
          «Вывод» — ушла не продажей, на внешний кошелёк. У обеих операций нет цены сделки, поэтому
          она берётся по рынку на тот момент и помечена знаком ≈. Прочерк вместо цены значит, что
          биржа такой пары не знает: по приходу прибыль тогда завышена на всю стоимость монеты, а
          вывод списывает её в убыток целиком.
        </p>
      ) : null}
    </main>
  )
}
