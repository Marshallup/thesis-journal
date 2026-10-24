import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Link } from 'react-router'
import { ApiError, api } from '../../shared/api/client.ts'
import { accountLabel } from '../../shared/ui/account-label.ts'
import { formatMoscowTime } from '../../shared/ui/format.ts'
import type { LabelledAccount } from '../../shared/ui/account-label.ts'

type Account = LabelledAccount
type KeyState = {
  exchange: string
  mask: string
  status: 'unverified' | 'active' | 'rejected'
  error: string | null
  verifiedAt: string | null
}
type KeysView = { enabled: boolean; key: KeyState | null }
type ImportRow = {
  id: string
  source: string
  status: 'uploaded' | 'parsing' | 'parsed' | 'failed'
  error: string | null
  result: { created: number; skipped: number; deferred: number } | null
  createdAt: string
}

// Права ключа проверяет воркер, и проверка — это поход на биржу. Двадцать
// секунд: обычно укладывается в одну, а если нет — виновата не наша страница,
// и честнее сказать это прямо, чем крутить спиннер.
const CHECK_MS = 20_000
// Синхронизация за два года — это сотня окон, и приезжают они по одному
// импорту. Три минуты потолка: дальше экран говорит, что работа продолжается
// в фоне, и показывает, что успело приехать.
const SYNC_MS = 180_000
// Сколько тишины считать концом работы: окна идут подряд, и пауза между ними
// короче секунды даже с ограничителем.
const QUIET_MS = 8_000
const POLL_MS = 1000

const STATUS: Record<KeyState['status'], string> = {
  unverified: 'ждёт проверки на бирже',
  active: 'проверен: только чтение',
  rejected: 'отклонён',
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Ключ записывает воркер, а права проверяет биржа: ответ на отправку приходит
// раньше результата. Поэтому экран ждёт и спрашивает, как и при импорте.
async function waitForCheck(accountId: string): Promise<KeysView> {
  const until = Date.now() + CHECK_MS
  for (;;) {
    const view = await api<KeysView>(`/accounts/${accountId}/keys`)
    if (view.key && view.key.status !== 'unverified') return view
    if (Date.now() > until) return view
    await sleep(POLL_MS)
  }
}

// Ждём, пока появится хотя бы один завершённый импорт свежее отсечки: иначе
// «синхронизировано» показывалось бы раньше, чем что-то приехало.
// Синхронизация идёт неделями: воркер создаёт импорт на каждое окно, где были
// сделки, и они приезжают по одному. Поэтому ждём не «появилась первая
// строка», а «строки перестали появляться»: прежняя проверка объявляла дело
// сделанным после первого окна, а остальные приезжали молча, и экран выглядел
// сломанным.
async function waitForSync(
  accountId: string,
  since: number,
  onProgress: (rows: ImportRow[]) => void,
): Promise<ImportRow[]> {
  const until = Date.now() + SYNC_MS
  let fresh: ImportRow[] = []
  let lastChange = Date.now()

  for (;;) {
    const rows = await api<ImportRow[]>(`/imports?accountId=${accountId}`)
    const now = rows.filter((row) => Date.parse(row.createdAt) >= since)
    if (now.length !== fresh.length) {
      lastChange = Date.now()
      fresh = now
      // Экран показывает строки по мере появления: иначе человек видит
      // замерший спиннер и не понимает, работает ли что-нибудь.
      onProgress(fresh)
    }

    const settled = fresh.every((row) => row.status === 'parsed' || row.status === 'failed')
    // Тишина дольше QUIET_MS при разобранных строках — значит воркер дошёл до
    // конца: окна идут одно за другим, пауза между ними короче секунды.
    if (fresh.length > 0 && settled && Date.now() - lastChange > QUIET_MS) return fresh
    if (Date.now() > until) return fresh
    await sleep(POLL_MS)
  }
}

// Итог по списку импортов: сколько сделок записано и сколько отложено. Без
// этих чисел экран говорит «готово» и не говорит, что именно случилось.
function countTrades(rows: ImportRow[]): number {
  return rows.reduce((sum, row) => sum + (row.result?.created ?? 0), 0)
}

function countDeferred(rows: ImportRow[]): number {
  return rows.reduce((sum, row) => sum + (row.result?.deferred ?? 0), 0)
}

function explain(error: unknown): string {
  if (error instanceof ApiError && (error.status === 400 || error.status === 403)) {
    return error.message
  }
  return 'Не получилось. Попробуйте ещё раз.'
}

export function ExchangePage() {
  const queryClient = useQueryClient()
  const accounts = useQuery({ queryKey: ['accounts'], queryFn: () => api<Account[]>('/accounts') })
  const [accountId, setAccountId] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [apiSecret, setApiSecret] = useState('')

  const keys = useQuery({
    queryKey: ['keys', accountId],
    queryFn: () => api<KeysView>(`/accounts/${accountId}/keys`),
    enabled: accountId !== '',
  })

  const imports = useQuery({
    queryKey: ['imports', accountId],
    queryFn: () => api<ImportRow[]>(`/imports?accountId=${accountId}`),
    enabled: accountId !== '',
  })

  const save = useMutation<KeysView>({
    mutationFn: async () => {
      await api(`/accounts/${accountId}/keys`, {
        method: 'POST',
        body: JSON.stringify({ exchange: 'bybit', apiKey, apiSecret }),
      })
      // Секрет из памяти страницы убираем сразу: держать его дольше, чем нужно
      // для отправки, незачем.
      setApiSecret('')
      return waitForCheck(accountId)
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['keys', accountId] })
    },
  })

  // Что уже приехало, пока идёт синхронизация. Держится отдельно от мутации:
  // react-query отдаёт результат только по завершении, а человеку нужно видеть
  // работу по ходу.
  const [progress, setProgress] = useState<ImportRow[]>([])

  const sync = useMutation<ImportRow[]>({
    mutationFn: async () => {
      const since = Date.now()
      setProgress([])
      await api(`/accounts/${accountId}/sync`, { method: 'POST', body: JSON.stringify({}) })
      return waitForSync(accountId, since, (rows) => {
        setProgress(rows)
        // Список импортов обновляется по ходу, а не в конце: строки должны
        // появляться на глазах.
        void queryClient.invalidateQueries({ queryKey: ['imports', accountId] })
      })
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['imports', accountId] })
      await queryClient.invalidateQueries({ queryKey: ['trades'] })
    },
  })

  const exchangeAccounts = accounts.data?.filter((account) => account.provider === 'bybit') ?? []

  if (accounts.isSuccess && exchangeAccounts.length === 0) {
    return (
      <main className="mx-auto w-full max-w-xl px-4 py-8">
        <h1 className="font-serif text-xl">Сначала счёт биржи</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Ключ принадлежит счёту, поэтому сначала нужен счёт с провайдером Bybit. Валюта у такого
          счёта обычно USDT.
        </p>
        <Link to="/accounts/new?next=/exchange" className="mt-4 inline-block text-sm text-accent">
          Завести счёт
        </Link>
      </main>
    )
  }

  const key = keys.data?.key ?? null
  const disabled = keys.data?.enabled === false

  return (
    <main className="mx-auto w-full max-w-2xl px-4 py-8">
      <header className="flex items-baseline justify-between">
        <h1 className="font-serif text-xl">Биржевой ключ</h1>
        <Link to="/" className="text-sm text-accent">
          Сделки
        </Link>
      </header>
      <p className="mt-1 text-sm text-ink-muted">
        Ключ нужен <strong className="font-semibold">только на чтение</strong>: дневник ничего не
        покупает и не выводит. Ключ с правом торговать или выводить средства будет отклонён и не
        сохранится вовсе — права проверяются у биржи до записи. Секрет шифруется и наружу больше не
        возвращается: на этом экране видно только маску.
      </p>
      <p className="mt-2 text-sm text-ink-muted">
        Синхронизируются сделки спота. Производные — перпетуалы, фьючерсы, опционы — пока нет:
        журнал считает длинные позиции по FIFO, и шорт с фондированием в эту модель не ложится.
      </p>

      <label className="mt-8 flex flex-col gap-1">
        <span className="text-sm text-ink-muted">Счёт</span>
        <select
          value={accountId}
          onChange={(event) => setAccountId(event.target.value)}
          className="rounded-sm border border-rule bg-surface px-2 py-1.5"
        >
          <option value="">выберите</option>
          {exchangeAccounts.map((account) => (
            <option key={account.id} value={account.id}>
              {accountLabel(account, exchangeAccounts)}
            </option>
          ))}
        </select>
      </label>

      {accountId === '' ? null : (
        <section className="mt-8 border-t border-rule pt-6">
          <h2 className="font-serif text-lg">Ключ</h2>

          {disabled ? (
            <p className="mt-2 text-sm text-ink-muted">
              Приём ключей выключен на сервере: не задан файл мастер-ключа, которым шифруется
              секрет. Пока так — остаётся{' '}
              <Link to="/imports" className="text-accent">
                импорт отчёта
              </Link>
              .
            </p>
          ) : null}

          {key ? (
            <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
              <dt className="text-ink-muted">Ключ</dt>
              <dd className="font-mono">{key.mask}</dd>
              <dt className="text-ink-muted">Биржа</dt>
              <dd>{key.exchange}</dd>
              <dt className="text-ink-muted">Состояние</dt>
              <dd className={key.status === 'rejected' ? 'text-loss' : undefined}>
                {STATUS[key.status]}
              </dd>
              {key.error ? (
                <>
                  <dt className="text-ink-muted">Причина</dt>
                  <dd className="text-loss">{key.error}</dd>
                </>
              ) : null}
              {key.verifiedAt ? (
                <>
                  <dt className="text-ink-muted">Проверен</dt>
                  <dd>{formatMoscowTime(key.verifiedAt)}</dd>
                </>
              ) : null}
            </dl>
          ) : (
            <p className="mt-2 text-sm text-ink-muted">Ключа пока нет.</p>
          )}

          {disabled ? null : (
            <form
              className="mt-5 flex flex-col gap-4"
              onSubmit={(event) => {
                event.preventDefault()
                save.mutate()
              }}
            >
              <label className="flex flex-col gap-1">
                <span className="text-sm text-ink-muted">Публичная часть ключа</span>
                <input
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                  required
                  autoComplete="off"
                  className="rounded-sm border border-rule bg-surface px-2 py-1.5 font-mono text-sm"
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-sm text-ink-muted">Секрет</span>
                {/* type=password не ради секретности на экране, а чтобы секрет
                    не попал в автозаполнение и в скриншот по невнимательности. */}
                <input
                  type="password"
                  value={apiSecret}
                  onChange={(event) => setApiSecret(event.target.value)}
                  required
                  autoComplete="off"
                  className="rounded-sm border border-rule bg-surface px-2 py-1.5 font-mono text-sm"
                />
              </label>
              <div className="flex items-baseline gap-4">
                <button
                  type="submit"
                  disabled={save.isPending}
                  className="rounded-sm bg-accent px-3 py-1.5 text-sm text-paper disabled:opacity-60"
                >
                  {save.isPending ? 'Проверяем у биржи' : key ? 'Заменить ключ' : 'Сохранить ключ'}
                </button>
                {save.isPending ? (
                  <span className="text-sm text-ink-muted">
                    Воркер расшифровывает ключ и спрашивает у биржи его права.
                  </span>
                ) : null}
                {save.isError ? (
                  <span className="text-sm text-loss">{explain(save.error)}</span>
                ) : null}
              </div>
              {key ? (
                <p className="text-sm text-ink-muted">
                  Новый ключ заменит прежний: на бирже у счёта один действующий ключ, и в журнале
                  так же. Проверка прав начнётся заново.
                </p>
              ) : null}
            </form>
          )}
        </section>
      )}

      {key?.status === 'active' ? (
        <section className="mt-8 border-t border-rule pt-6">
          <h2 className="font-serif text-lg">Синхронизация</h2>
          <p className="mt-1 text-sm text-ink-muted">
            Первая синхронизация берёт историю, какую отдаёт биржа, дальше — только новое с того
            места, где остановились. Повторный запуск безопасен: сделки не задваиваются.
          </p>
          <div className="mt-4 flex items-baseline gap-4">
            <button
              type="button"
              onClick={() => sync.mutate()}
              disabled={sync.isPending}
              className="rounded-sm border border-rule px-3 py-1.5 text-sm disabled:opacity-60"
            >
              {sync.isPending ? 'Синхронизируем' : 'Синхронизировать'}
            </button>
            {sync.isPending ? (
              <span className="text-sm text-ink-muted">
                Воркер идёт на биржу окнами по семь дней, по импорту на окно со сделками.{' '}
                {progress.length > 0
                  ? `Уже приехало: ${progress.length}, сделок ${countTrades(progress)}.`
                  : 'Первые строки появятся через несколько секунд.'}
              </span>
            ) : null}
            {sync.isError ? <span className="text-sm text-loss">{explain(sync.error)}</span> : null}
          </div>

          {sync.isSuccess ? (
            <p className="mt-4 text-sm">
              {sync.data.length === 0 ? (
                'Новых сделок нет: биржа отдала то же, что в прошлый раз.'
              ) : (
                <>
                  Синхронизация закончилась: импортов{' '}
                  <span className="tabular">{sync.data.length}</span>, сделок записано{' '}
                  <span className="tabular">{countTrades(sync.data)}</span>
                  {countDeferred(sync.data) > 0 ? (
                    <>
                      , отложено до появления покупок{' '}
                      <span className="tabular">{countDeferred(sync.data)}</span>
                    </>
                  ) : null}
                  .
                </>
              )}
            </p>
          ) : null}

          {sync.isSuccess && sync.data.length > 0 ? (
            // Воркер мог не успеть за время ожидания: окон бывает сотня.
            // Сказать об этом честнее, чем оставить человека гадать, почему
            // строки продолжают появляться после «готово».
            <p className="mt-1 text-xs text-ink-muted">
              Если строки продолжают появляться — воркер ещё идёт по окнам. Обновите страницу через
              минуту: импорты дописываются сами, повторно запускать не нужно.
            </p>
          ) : null}

          {(imports.data?.length ?? 0) > 0 ? (
            <table className="mt-5 w-full text-sm">
              <caption className="pb-2 text-left text-xs text-ink-muted">
                Импорты этого счёта — и из отчётов, и из синхронизации
              </caption>
              <thead className="text-xs text-ink-muted">
                <tr className="border-b border-rule">
                  <th className="py-1 text-left font-normal">Когда</th>
                  <th className="py-1 text-left font-normal">Источник</th>
                  <th className="py-1 text-left font-normal">Состояние</th>
                  <th className="py-1 text-right font-normal">Записано</th>
                </tr>
              </thead>
              <tbody>
                {imports.data?.map((row) => (
                  <tr key={row.id} className="border-b border-rule/60">
                    <td className="py-1">{formatMoscowTime(row.createdAt)}</td>
                    <td className="py-1">{row.source}</td>
                    <td className={`py-1 ${row.status === 'failed' ? 'text-loss' : ''}`}>
                      {row.status === 'failed' ? (row.error ?? 'отказ') : row.status}
                    </td>
                    <td className="py-1 text-right tabular-nums">
                      {row.result
                        ? `${row.result.created} из ${row.result.created + row.result.skipped}`
                        : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
        </section>
      ) : null}
    </main>
  )
}
