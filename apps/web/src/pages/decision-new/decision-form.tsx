import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { api } from '../../shared/api/client.ts'
import { accountLabel } from '../../shared/ui/account-label.ts'
import type { LabelledAccount } from '../../shared/ui/account-label.ts'
import {
  daysLabel,
  EXECUTION_DAYS,
  HOLD_DAYS,
  MOOD_KEYS,
  moodLabel,
} from '../../shared/ui/decision-labels.ts'
import { formatMoscowTime } from '../../shared/ui/format.ts'
import { Money } from '../../shared/ui/money.tsx'

type Account = LabelledAccount & { kind: string }
type Instrument = { id: string; symbol: string }

type UnlinkedTrade = {
  id: string
  accountId: string
  side: 'buy' | 'sell'
  quantity: string
  price: string
  executedAt: string
}

type ContextSnapshot = {
  capturedAt: string
  localHour: number
  weekday: number
  tradesLast24h: number
  portfolioDrawdownPct: string | null
}

// Сроки фиксированные: свободный ввод дней превращает решение в торг с собой,
// а несколько вариантов заставляют выбрать.
const CONVICTIONS = [1, 2, 3, 4, 5] as const
const WEEKDAYS = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота']

export function DecisionForm() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  const accounts = useQuery({ queryKey: ['accounts'], queryFn: () => api<Account[]>('/accounts') })
  const instruments = useQuery({
    queryKey: ['instruments'],
    queryFn: () => api<Instrument[]>('/instruments'),
  })

  // Форму открывают и с экрана «сделки без тезиса» — тогда счёт, бумага и
  // сторона известны из сделки, и переспрашивать их значит приглашать ошибку.
  const [params] = useSearchParams()
  const postFactum = params.get('postFactum') === '1'
  // Сделка, из-за которой открыли форму: её привяжет само создание решения.
  const tradeId = params.get('tradeId')
  const next = params.get('next') ?? '/decisions'

  const [accountId, setAccountId] = useState(params.get('accountId') ?? '')
  const [instrumentId, setInstrumentId] = useState(params.get('instrumentId') ?? '')
  const [side, setSide] = useState<'buy' | 'sell'>(params.get('side') === 'sell' ? 'sell' : 'buy')
  // Сделка из ссылки отмечена заранее: на экране разметки её уже выбрали.
  const [picked, setPicked] = useState<string[]>(tradeId ? [tradeId] : [])
  const [thesis, setThesis] = useState('')
  // Без значения по умолчанию: в журнале пять записей из восьми стояли на
  // девяноста днях — то есть срок не выбирали, а принимали. Поле, которое не
  // выбирают, не данные.
  const [horizonDays, setHorizonDays] = useState<number | null>(null)
  const [holdDays, setHoldDays] = useState<number | null>(null)
  const [conviction, setConviction] = useState<number>(3)
  const [mood, setMood] = useState<string>(MOOD_KEYS[0]!)
  const [invalidator, setInvalidator] = useState('')
  const [freeTextOpen, setFreeTextOpen] = useState(false)
  const [freeText, setFreeText] = useState('')

  const ready = accountId !== '' && instrumentId !== ''

  // Непривязанные сделки по этой бумаге: сервер примет только те, у которых
  // совпадают счёт, бумага и сторона, поэтому остальные отсеиваются здесь.
  const unlinked = useQuery({
    queryKey: ['trades', 'unlinked', instrumentId],
    queryFn: () => api<UnlinkedTrade[]>(`/trades?linked=false&instrumentId=${instrumentId}`),
    enabled: ready,
  })
  const own = (unlinked.data ?? []).filter(
    (trade) => trade.accountId === accountId && trade.side === side,
  )

  // Любая уже существующая сделка случилась раньше этой записи, поэтому выбор
  // сделки означает решение задним числом. Пометка ставится сама, а не
  // спрашивается: вопрос «это задним числом?» человек ответил бы как удобнее.
  const retro = postFactum || picked.length > 0

  // Срок удержания есть только у покупки: продажа ничего не держит.
  const holds = side === 'buy'
  const complete = horizonDays !== null && (!holds || holdDays !== null)

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
          ...(holds && holdDays !== null ? { holdDays } : {}),
          conviction,
          mood,
          ...(retro ? { postFactum: true } : {}),
          ...(picked.length > 0 ? { tradeIds: picked } : {}),
          ...(invalidator ? { invalidator } : {}),
          ...(freeText ? { freeText } : {}),
        }),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['decisions'] })
      // Сделка перестала быть без тезиса — список разметки обязан это знать.
      await queryClient.invalidateQueries({ queryKey: ['trades'] })
      // В журнал, а не на сделки: запись должна быть видна сразу, иначе
      // человек не понимает, произошло ли что-нибудь.
      void navigate(next)
    },
  })

  return (
    <main className="mx-auto w-full max-w-2xl px-4 py-8">
      <h1 className="font-serif text-xl">{retro ? 'Решение задним числом' : 'Решение'}</h1>
      <p className="mt-1 text-sm text-ink-muted">
        {retro
          ? // Пометка не наказание, а защита статистики: задним числом тезис пишется, когда исход уже известен, и такие записи нельзя смешивать с теми, что писались до сделки.
            'Сделка уже есть, тезис пишется после. Запись будет помечена как post factum и не попадёт в поведенческие срезы — иначе они покажут не ваши решения, а то, как вы их объясняете.'
          : 'Записывается до сделки и больше не меняется. Правка создаёт ревизию.'}
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
              onChange={(event) => {
                setAccountId(event.target.value)
                setPicked([])
              }}
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
              onChange={(event) => {
                setInstrumentId(event.target.value)
                setPicked([])
              }}
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
              onChange={(event) => {
                setSide(event.target.value === 'sell' ? 'sell' : 'buy')
                setPicked([])
                setHoldDays(null)
              }}
              className="rounded-sm border border-rule bg-surface px-2 py-1.5"
            >
              <option value="buy">покупка</option>
              <option value="sell">продажа</option>
            </select>
          </label>
        </div>

        {ready ? (
          <fieldset className="flex flex-col gap-1">
            <legend className="text-sm text-ink-muted">Сделки без тезиса по этой бумаге</legend>
            {own.length === 0 ? (
              <p className="text-sm text-ink-muted">
                Таких сделок нет — значит, решение пишется до сделки. Так и задумано.
              </p>
            ) : (
              <ul className="flex flex-col gap-1 text-sm">
                {own.map((trade) => (
                  <li key={trade.id}>
                    <label className="flex items-baseline gap-3">
                      <input
                        type="checkbox"
                        checked={picked.includes(trade.id)}
                        onChange={() =>
                          setPicked((current) =>
                            current.includes(trade.id)
                              ? current.filter((id) => id !== trade.id)
                              : [...current, trade.id],
                          )
                        }
                      />
                      <span className="tabular text-ink-muted">
                        {formatMoscowTime(trade.executedAt)}
                      </span>
                      <Money value={trade.quantity} fractionDigits={0} maxFractionDigits={18} />
                      <span className="text-ink-muted">по</span>
                      <Money value={trade.price} />
                    </label>
                  </li>
                ))}
              </ul>
            )}
            {picked.length > 0 && !postFactum ? (
              <p className="mt-1 text-sm text-loss">
                Выбранные сделки уже случились, поэтому запись будет помечена «задним числом» и не
                попадёт в оценку решений.
              </p>
            ) : null}
          </fieldset>
        ) : null}

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
          <legend className="text-sm text-ink-muted">Срок на исполнение</legend>
          <div className="flex gap-2">
            {EXECUTION_DAYS.map((days) => (
              <button
                key={days}
                type="button"
                onClick={() => setHorizonDays(days)}
                aria-pressed={horizonDays === days}
                className={`tabular rounded-sm border px-3 py-1 ${
                  horizonDays === days ? 'border-accent text-accent' : 'border-rule text-ink-muted'
                }`}
              >
                {daysLabel(days)}
              </button>
            ))}
          </div>
          <p className="text-xs text-ink-muted">
            За этот срок намерение должно стать сделкой. Не стало — решение останется несовершённым,
            и это тоже запись о вас.
          </p>
        </fieldset>

        {holds ? (
          <fieldset className="flex flex-col gap-1">
            <legend className="text-sm text-ink-muted">Срок удержания</legend>
            <div className="flex gap-2">
              {HOLD_DAYS.map((days) => (
                <button
                  key={days}
                  type="button"
                  onClick={() => setHoldDays(days)}
                  aria-pressed={holdDays === days}
                  className={`tabular rounded-sm border px-3 py-1 ${
                    holdDays === days ? 'border-accent text-accent' : 'border-rule text-ink-muted'
                  }`}
                >
                  {daysLabel(days)}
                </button>
              ))}
            </div>
            <p className="text-xs text-ink-muted">
              На сколько заходите. Потом по нему видно главное: продали раньше, чем сами себе
              обещали, или досидели.
            </p>
          </fieldset>
        ) : null}

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
            {MOOD_KEYS.map((item) => (
              <option key={item} value={item}>
                {moodLabel(item)}
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

        {complete ? null : (
          <p className="text-sm text-ink-muted">
            Осталось выбрать срок на исполнение{holds ? ' и срок удержания' : ''}.
          </p>
        )}

        <button
          type="submit"
          disabled={save.isPending || !complete}
          className="self-start rounded-sm bg-accent px-3 py-1.5 text-paper disabled:opacity-60"
        >
          {save.isPending ? 'Записываем' : 'Записать'}
        </button>
      </form>
    </main>
  )
}
