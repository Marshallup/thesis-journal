import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { api } from '../../shared/api/client.ts'
import { accountLabel } from '../../shared/ui/account-label.ts'
import type { LabelledAccount } from '../../shared/ui/account-label.ts'

type Account = LabelledAccount & { kind: string }
type Instrument = { id: string; symbol: string }

type ContextSnapshot = {
  capturedAt: string
  localHour: number
  weekday: number
  tradesLast24h: number
  portfolioDrawdownPct: string | null
}

// Горизонты фиксированные: свободный ввод дней превращает решение в торг
// с собой, а четыре варианта заставляют выбрать.
const HORIZONS = [7, 30, 90, 365] as const
const CONVICTIONS = [1, 2, 3, 4, 5] as const
const MOODS = ['спокойно', 'азарт', 'страх', 'скука', 'упустить'] as const
const WEEKDAYS = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота']

export function DecisionForm() {
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
  const [thesis, setThesis] = useState('')
  const [horizonDays, setHorizonDays] = useState<number>(90)
  const [conviction, setConviction] = useState<number>(3)
  const [mood, setMood] = useState<string>(MOODS[0])
  const [invalidator, setInvalidator] = useState('')
  const [freeTextOpen, setFreeTextOpen] = useState(false)
  const [freeText, setFreeText] = useState('')

  const ready = accountId !== '' && instrumentId !== ''

  // Снимок подтягивается сам и только показывается. При записи сервер считает
  // свой — этот предпросмотр отправить нельзя.
  const context = useQuery({
    queryKey: ['context', accountId, instrumentId],
    enabled: ready,
    queryFn: () =>
      api<ContextSnapshot>(
        `/decisions/context?accountId=${accountId}&instrumentId=${instrumentId}`,
      ),
  })

  const save = useMutation({
    mutationFn: () =>
      api('/decisions', {
        method: 'POST',
        body: JSON.stringify({
          accountId,
          instrumentId,
          side,
          thesis,
          horizonDays,
          conviction,
          mood,
          ...(invalidator ? { invalidator } : {}),
          ...(freeText ? { freeText } : {}),
        }),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['decisions'] })
      // В журнал, а не на сделки: запись должна быть видна сразу, иначе
      // человек не понимает, произошло ли что-нибудь.
      void navigate('/decisions')
    },
  })

  return (
    <main className="mx-auto w-full max-w-2xl px-4 py-8">
      <h1 className="font-serif text-xl">Решение</h1>
      <p className="mt-1 text-sm text-ink-muted">
        Записывается до сделки и больше не меняется. Правка создаёт ревизию.
      </p>

      <form
        className="mt-8 flex flex-col gap-5"
        onSubmit={(event) => {
          event.preventDefault()
          save.mutate()
        }}
      >
        <div className="flex gap-4">
          <label className="flex flex-1 flex-col gap-1">
            <span className="flex items-baseline justify-between text-sm text-ink-muted">
              Счёт
              <Link to="/accounts/new?next=/decisions/new" className="text-accent">
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
                  {accountLabel(account, accounts.data ?? [])}
                </option>
              ))}
            </select>
          </label>

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

        <label className="flex flex-col gap-1">
          <span className="text-sm text-ink-muted">Тезис</span>
          <input
            value={thesis}
            onChange={(event) => setThesis(event.target.value)}
            required
            maxLength={500}
            placeholder="почему я это делаю"
            className="rounded-sm border border-rule bg-surface px-2 py-1.5 font-serif"
          />
        </label>

        <fieldset className="flex flex-col gap-1">
          <legend className="text-sm text-ink-muted">Горизонт</legend>
          <div className="flex gap-2">
            {HORIZONS.map((days) => (
              <button
                key={days}
                type="button"
                onClick={() => setHorizonDays(days)}
                aria-pressed={horizonDays === days}
                className={`tabular rounded-sm border px-3 py-1 ${
                  horizonDays === days ? 'border-accent text-accent' : 'border-rule text-ink-muted'
                }`}
              >
                {days} дней
              </button>
            ))}
          </div>
        </fieldset>

        <fieldset className="flex flex-col gap-1">
          <legend className="text-sm text-ink-muted">Уверенность</legend>
          <div className="flex gap-2">
            {CONVICTIONS.map((level) => (
              <button
                key={level}
                type="button"
                onClick={() => setConviction(level)}
                aria-pressed={conviction === level}
                className={`tabular w-9 rounded-sm border py-1 ${
                  conviction === level ? 'border-accent text-accent' : 'border-rule text-ink-muted'
                }`}
              >
                {level}
              </button>
            ))}
          </div>
        </fieldset>

        <label className="flex flex-col gap-1">
          <span className="text-sm text-ink-muted">Настроение</span>
          <select
            value={mood}
            onChange={(event) => setMood(event.target.value)}
            className="w-48 rounded-sm border border-rule bg-surface px-2 py-1.5"
          >
            {MOODS.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-sm text-ink-muted">Что докажет, что я неправ</span>
          <input
            value={invalidator}
            onChange={(event) => setInvalidator(event.target.value)}
            maxLength={500}
            className="rounded-sm border border-rule bg-surface px-2 py-1.5 font-serif"
          />
        </label>

        <div className="flex flex-col gap-1">
          <button
            type="button"
            onClick={() => setFreeTextOpen(!freeTextOpen)}
            aria-expanded={freeTextOpen}
            className="self-start text-sm text-accent"
          >
            {freeTextOpen ? 'Свернуть подробности' : 'Добавить подробности'}
          </button>
          {freeTextOpen ? (
            <textarea
              value={freeText}
              onChange={(event) => setFreeText(event.target.value)}
              rows={5}
              maxLength={5000}
              className="prose-thesis rounded-sm border border-rule bg-surface px-2 py-1.5"
            />
          ) : null}
        </div>

        {/* Снимок серый и нередактируемый: это контекст, а не поле ввода. */}
        <section className="border-t border-rule pt-4 text-sm text-ink-muted">
          <h2 className="text-sm">Контекст записи</h2>
          {!ready ? (
            <p className="mt-1">Появится после выбора счёта и инструмента.</p>
          ) : context.isSuccess ? (
            <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-6 gap-y-1">
              <dt>Час по Москве</dt>
              <dd className="tabular">{String(context.data.localHour).padStart(2, '0')}:00</dd>
              <dt>День недели</dt>
              <dd>{WEEKDAYS[context.data.weekday]}</dd>
              <dt>Сделок за сутки</dt>
              <dd className="tabular">{context.data.tradesLast24h}</dd>
              <dt>Просадка портфеля</dt>
              <dd>{context.data.portfolioDrawdownPct ?? 'пока не считается'}</dd>
            </dl>
          ) : (
            <p className="mt-1">Загружаем</p>
          )}
        </section>

        {save.isError ? (
          <p role="alert" className="text-sm text-loss">
            Не удалось записать решение.
          </p>
        ) : null}

        <button
          type="submit"
          disabled={save.isPending}
          className="self-start rounded-sm bg-accent px-3 py-1.5 text-paper disabled:opacity-60"
        >
          {save.isPending ? 'Записываем' : 'Записать'}
        </button>
      </form>
    </main>
  )
}
