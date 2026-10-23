import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { api } from '../../../shared/api/client.ts'

type Account = { id: string }

// Подписи человеческие, значения — те, что проверяет база. Вид счёта форма не
// спрашивает и не считает: его выводит сервер из провайдера.
const PROVIDERS = [
  { value: 'manual', label: 'без брокера, записываю руками' },
  { value: 'sber', label: 'Сбер' },
  { value: 'tinvest', label: 'Т-Инвестиции' },
  { value: 'bybit', label: 'Bybit' },
  { value: 'bitget', label: 'Bitget' },
] as const

// Валюта по умолчанию следует из провайдера: у биржи это USDT, а не USD —
// пары котируются в нём, и баланс спота номинирован в нём же. Приравнивать
// их — отдельное допущение, и место ему не в форме.
const CURRENCY_BY_PROVIDER: Record<string, string> = { bybit: 'USDT', bitget: 'USDT' }

export function AccountForm() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  // Возвращаемся туда, откуда пришли: счёт заводят по ходу записи, а не
  // отдельным походом в настройки.
  const [params] = useSearchParams()
  const next = params.get('next') ?? '/trades/new'

  const [name, setName] = useState('')
  const [provider, setProvider] = useState<string>('manual')
  const [baseCurrency, setBaseCurrency] = useState('RUB')
  // Подсказку перестаём навязывать, как только человек ввёл своё: у него может
  // быть счёт в валюте, которой мы не знаем.
  const [currencyTouched, setCurrencyTouched] = useState(false)
  const [isIis, setIsIis] = useState(false)

  const save = useMutation({
    mutationFn: () =>
      api<Account>('/accounts', {
        method: 'POST',
        // Пустое имя не отправляем вовсе: в базе ему место NULL, а не пустая
        // строка, иначе два безымянных счёта столкнутся на уникальном индексе.
        body: JSON.stringify({
          ...(name.trim() ? { name: name.trim() } : {}),
          provider,
          baseCurrency,
          isIis,
        }),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['accounts'] })
      void navigate(next)
    },
  })

  return (
    <main className="mx-auto w-full max-w-xl px-4 py-8">
      <h1 className="font-serif text-xl">Куда записываем</h1>
      <p className="mt-1 text-sm text-ink-muted">
        Сделки и решения привязываются к счёту. Если брокера нет, подойдёт ручной — его можно
        завести прямо сейчас и уточнить позже.
      </p>

      <form
        className="mt-8 flex flex-col gap-5"
        onSubmit={(event) => {
          event.preventDefault()
          save.mutate()
        }}
      >
        <label className="flex flex-col gap-1">
          <span className="text-sm text-ink-muted">Название, необязательно</span>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={50}
            placeholder="ИИС, брокерский, старый у Сбера"
            className="rounded-sm border border-rule bg-surface px-2 py-1.5"
          />
          <span className="text-xs text-ink-muted">
            Нужно, чтобы различать счета в списках. Два счёта одного брокера без названий отличаются
            только датой открытия.
          </span>
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-sm text-ink-muted">Где счёт</span>
          <select
            value={provider}
            onChange={(event) => {
              setProvider(event.target.value)
              if (!currencyTouched) {
                setBaseCurrency(CURRENCY_BY_PROVIDER[event.target.value] ?? 'RUB')
              }
            }}
            className="rounded-sm border border-rule bg-surface px-2 py-1.5"
          >
            {PROVIDERS.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-sm text-ink-muted">Базовая валюта</span>
          <input
            value={baseCurrency}
            onChange={(event) => {
              setCurrencyTouched(true)
              setBaseCurrency(event.target.value.toUpperCase())
            }}
            required
            minLength={3}
            // Десять, а не три: тикеры стейблкоинов в ISO 4217 не укладываются,
            // и с тройкой биржевой счёт нельзя было завести вовсе — поле просто
            // не давало дописать `USDT`.
            maxLength={10}
            className="tabular w-28 rounded-sm border border-rule bg-surface px-2 py-1.5"
          />
          <span className="text-xs text-ink-muted">
            Код валюты, в которой считается счёт: RUB, USD. У биржи это стейблкоин — USDT: пары
            котируются в нём, и USD на таком счёте не бывает.
          </span>
        </label>

        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={isIis}
            onChange={(event) => setIsIis(event.target.checked)}
          />
          <span className="text-sm">
            ИИС
            <span className="text-ink-muted"> — свой горизонт и налоговый режим</span>
          </span>
        </label>

        {save.isError ? (
          <p role="alert" className="text-sm text-loss">
            Не удалось завести счёт.
          </p>
        ) : null}

        <button
          type="submit"
          disabled={save.isPending}
          className="self-start rounded-sm bg-accent px-3 py-1.5 text-paper disabled:opacity-60"
        >
          {save.isPending ? 'Заводим' : 'Завести счёт'}
        </button>
      </form>
    </main>
  )
}
