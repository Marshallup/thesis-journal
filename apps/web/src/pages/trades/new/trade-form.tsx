import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { api } from '../../../shared/api/client.ts'

type Account = { id: string; provider: string; isIis: boolean }
type Instrument = { id: string; symbol: string }

const CLASSES = ['equity', 'bond', 'etf', 'crypto', 'currency'] as const

// Та же форма, что проверяет dto на сервере: деньги остаются строками, в
// number не превращаются ни в состоянии формы, ни в запросе.
const DECIMAL = /^\d+(\.\d+)?$/

export function TradeForm() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  const accounts = useQuery({ queryKey: ['accounts'], queryFn: () => api<Account[]>('/accounts') })
  const instruments = useQuery({
    queryKey: ['instruments'],
    queryFn: () => api<Instrument[]>('/instruments'),
  })

  const [accountId, setAccountId] = useState('')
  const [instrumentId, setInstrumentId] = useState('')
  const [side, setSide] = useState<'buy' | 'sell'>('buy')
  const [quantity, setQuantity] = useState('')
  const [price, setPrice] = useState('')
  const [fee, setFee] = useState('0')
  const [executedAt, setExecutedAt] = useState('')

  const [adding, setAdding] = useState(false)
  const [symbol, setSymbol] = useState('')
  const [klass, setKlass] = useState<string>('equity')
  const [currency, setCurrency] = useState('RUB')

  const addInstrument = useMutation({
    mutationFn: () =>
      api<Instrument>('/instruments', {
        method: 'POST',
        body: JSON.stringify({ symbol, class: klass, currency }),
      }),
    onSuccess: async (created) => {
      await queryClient.invalidateQueries({ queryKey: ['instruments'] })
      setInstrumentId(created.id)
      setAdding(false)
      setSymbol('')
    },
  })

  const save = useMutation({
    mutationFn: () =>
      api('/trades', {
        method: 'POST',
        body: JSON.stringify({
          accountId,
          instrumentId,
          side,
          quantity,
          price,
          fee,
          // datetime-local отдаёт время без зоны, то есть местное. Переводим в
          // UTC через браузерную зону — это и есть то, что имел в виду человек,
          // когда вводил «13:40».
          executedAt: new Date(executedAt).toISOString(),
        }),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['trades'] })
      void navigate('/')
    },
  })

  const valid =
    accountId !== '' &&
    instrumentId !== '' &&
    DECIMAL.test(quantity) &&
    DECIMAL.test(price) &&
    DECIMAL.test(fee) &&
    executedAt !== ''

  if (accounts.isSuccess && accounts.data.length === 0) {
    return (
      <main className="mx-auto w-full max-w-xl px-4 py-8">
        <h1 className="font-serif text-xl">Сначала счёт</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Сделка привязывается к счёту, поэтому записывать пока некуда.
        </p>
        <Link to="/accounts/new" className="mt-4 inline-block text-sm text-accent">
          Завести счёт
        </Link>
      </main>
    )
  }

  return (
    <main className="mx-auto w-full max-w-2xl px-4 py-8">
      <h1 className="font-serif text-xl">Сделка</h1>
      <p className="mt-1 text-sm text-ink-muted">
        Факт: что и по какой цене. Почему — отдельной записью решения, до сделки.
      </p>

      <form
        className="mt-8 flex flex-col gap-5"
        onSubmit={(event) => {
          event.preventDefault()
          save.mutate()
        }}
      >
        <div className="flex items-end gap-4">
          <label className="flex flex-1 flex-col gap-1">
            <span className="flex items-baseline justify-between text-sm text-ink-muted">
              Счёт
              <Link to="/accounts/new?next=/trades/new" className="text-accent">
                добавить
              </Link>
            </span>
            <select
              value={accountId}
              onChange={(event) => setAccountId(event.target.value)}
              required
              className="rounded-sm border border-rule bg-surface px-2 py-1.5"
            >
              <option value="">выберите</option>
              {accounts.data?.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.provider}
                  {account.isIis ? ', ИИС' : ''}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-sm text-ink-muted">Сторона</span>
            <select
              value={side}
              onChange={(event) => setSide(event.target.value === 'sell' ? 'sell' : 'buy')}
              className="rounded-sm border border-rule bg-surface px-2 py-1.5"
            >
              <option value="buy">покупка</option>
              <option value="sell">продажа</option>
            </select>
          </label>
        </div>

        <div className="flex items-end gap-3">
          <label className="flex flex-1 flex-col gap-1">
            <span className="text-sm text-ink-muted">Инструмент</span>
            <select
              value={instrumentId}
              onChange={(event) => setInstrumentId(event.target.value)}
              required
              className="rounded-sm border border-rule bg-surface px-2 py-1.5"
            >
              <option value="">выберите</option>
              {instruments.data?.map((instrument) => (
                <option key={instrument.id} value={instrument.id}>
                  {instrument.symbol}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            onClick={() => setAdding(!adding)}
            aria-expanded={adding}
            className="pb-2 text-sm text-accent"
          >
            {adding ? 'Отменить' : 'Добавить инструмент'}
          </button>
        </div>

        {adding ? (
          // Добавление рядом, а не на отдельной странице: уходить из формы
          // сделки за тикером — верный способ потерять введённое.
          <div className="flex items-end gap-3 border-l border-rule pl-4">
            <label className="flex flex-col gap-1">
              <span className="text-sm text-ink-muted">Тикер</span>
              <input
                value={symbol}
                onChange={(event) => setSymbol(event.target.value.toUpperCase())}
                maxLength={32}
                className="tabular w-32 rounded-sm border border-rule bg-surface px-2 py-1.5"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-sm text-ink-muted">Класс</span>
              <select
                value={klass}
                onChange={(event) => setKlass(event.target.value)}
                className="rounded-sm border border-rule bg-surface px-2 py-1.5"
              >
                {CLASSES.map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-sm text-ink-muted">Валюта</span>
              <input
                value={currency}
                onChange={(event) => setCurrency(event.target.value.toUpperCase())}
                minLength={3}
                maxLength={3}
                className="tabular w-20 rounded-sm border border-rule bg-surface px-2 py-1.5"
              />
            </label>
            <button
              type="button"
              onClick={() => addInstrument.mutate()}
              disabled={symbol === '' || addInstrument.isPending}
              className="rounded-sm border border-rule px-3 py-1.5 text-sm disabled:opacity-60"
            >
              Добавить
            </button>
          </div>
        ) : null}

        <div className="flex gap-4">
          <label className="flex flex-col gap-1">
            <span className="text-sm text-ink-muted">Количество</span>
            <input
              value={quantity}
              onChange={(event) => setQuantity(event.target.value)}
              inputMode="decimal"
              required
              className="tabular w-36 rounded-sm border border-rule bg-surface px-2 py-1.5 text-right"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-sm text-ink-muted">Цена</span>
            <input
              value={price}
              onChange={(event) => setPrice(event.target.value)}
              inputMode="decimal"
              required
              className="tabular w-36 rounded-sm border border-rule bg-surface px-2 py-1.5 text-right"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-sm text-ink-muted">Комиссия</span>
            <input
              value={fee}
              onChange={(event) => setFee(event.target.value)}
              inputMode="decimal"
              required
              className="tabular w-36 rounded-sm border border-rule bg-surface px-2 py-1.5 text-right"
            />
          </label>
        </div>

        <label className="flex flex-col gap-1">
          <span className="text-sm text-ink-muted">Исполнена, местное время</span>
          <input
            type="datetime-local"
            value={executedAt}
            onChange={(event) => setExecutedAt(event.target.value)}
            required
            className="tabular w-56 rounded-sm border border-rule bg-surface px-2 py-1.5"
          />
        </label>

        {save.isError ? (
          <p role="alert" className="text-sm text-loss">
            Не удалось записать сделку. Проверьте количество и цену.
          </p>
        ) : null}

        <button
          type="submit"
          disabled={!valid || save.isPending}
          className="self-start rounded-sm bg-accent px-3 py-1.5 text-paper disabled:opacity-60"
        >
          {save.isPending ? 'Записываем' : 'Записать сделку'}
        </button>
      </form>
    </main>
  )
}
