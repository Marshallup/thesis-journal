import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useId, useState } from 'react'
import { Link } from 'react-router'
import { ApiError, api } from '../../shared/api/client.ts'
import { formatMoscowTime } from '../../shared/ui/format.ts'
import { Money } from '../../shared/ui/money.tsx'
import { accountLabel } from '../../shared/ui/account-label.ts'
import type { LabelledAccount } from '../../shared/ui/account-label.ts'

type Account = LabelledAccount
type Instrument = { id: string; symbol: string }
type Pending = {
  id: string
  importId: string
  instrumentId: string
  quantity: string
  missing: string
  occurredAt: string
}
type Upload = { importId: string; status: 'uploaded' | 'duplicate' }
type ImportResult = { created: number; skipped: number; deferred: number }
type ImportStatus = {
  id: string
  status: 'uploaded' | 'parsing' | 'parsed' | 'failed'
  error: string | null
  result: ImportResult | null
}
type Applied = ImportStatus & { duplicate: boolean }

// Разбор идёт в другом процессе, поэтому экран ждёт и спрашивает. Тридцать
// секунд: отчёт за год разбирается за пару, а если не уложились — виноват не
// таймаут, и честнее сказать это прямо, чем крутить спиннер.
const WAIT_MS = 30_000
const POLL_MS = 1000

async function waitForImport(importId: string): Promise<ImportStatus> {
  const until = Date.now() + WAIT_MS
  for (;;) {
    const status = await api<ImportStatus>(`/imports/${importId}`)
    if (status.status === 'parsed' || status.status === 'failed') return status
    if (Date.now() > until) return status
    await new Promise((resolve) => setTimeout(resolve, POLL_MS))
  }
}

// Отказы бэкенда, которые человек должен понять без чтения логов. 409 приходит
// без текста — это состояние, а не ошибка формы; у 400 текст есть, и он
// полезнее любого нашего пересказа.
function explain(error: unknown): string {
  if (error instanceof ApiError && error.status === 409) {
    return 'Отчёт по этому счёту уже применяется. Подождите и попробуйте снова.'
  }
  if (error instanceof ApiError && error.status === 400) return error.message
  return 'Не получилось. Попробуйте ещё раз.'
}

export function ImportPage() {
  const queryClient = useQueryClient()
  const fileInputId = useId()

  const accounts = useQuery({ queryKey: ['accounts'], queryFn: () => api<Account[]>('/accounts') })
  const pending = useQuery({
    queryKey: ['imports', 'deferred'],
    queryFn: () => api<Pending[]>('/imports/deferred'),
  })
  const instruments = useQuery({
    queryKey: ['instruments'],
    queryFn: () => api<Instrument[]>('/instruments'),
  })
  const [accountId, setAccountId] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [dragging, setDragging] = useState(false)

  const send = useMutation<Applied>({
    mutationFn: async () => {
      if (!file) throw new Error('файл не выбран')
      const form = new FormData()
      form.append('file', file)
      form.append('accountId', accountId)

      // Заливка только принимает файл: разбирает его воркер, а применяет
      // консьюмер событий. Поэтому второй шаг — не «примени», а «подожди и
      // спроси, чем кончилось».
      const uploaded = await api<Upload>('/imports', { method: 'POST', body: form })
      const status = await waitForImport(uploaded.importId)
      return { ...status, duplicate: uploaded.status === 'duplicate' }
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['trades'] })
      await queryClient.invalidateQueries({ queryKey: ['imports', 'deferred'] })
    },
  })

  // Повторное применение уже залитого отчёта: файл лежит на сервере, и
  // загружать его второй раз незачем — именно этого не хватало, когда
  // отложенная продажа ждала покупки.
  const reapply = useMutation({
    mutationFn: async (importId: string) => {
      await api<ImportStatus>(`/imports/${importId}/apply`, { method: 'POST' })
      return waitForImport(importId)
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['trades'] })
      await queryClient.invalidateQueries({ queryKey: ['imports', 'deferred'] })
    },
  })

  const symbols = new Map(instruments.data?.map((item) => [item.id, item.symbol]))
  const byImport = new Map<string, Pending[]>()
  for (const operation of pending.data ?? []) {
    byImport.set(operation.importId, [...(byImport.get(operation.importId) ?? []), operation])
  }

  const sberAccounts = accounts.data?.filter((account) => account.provider === 'sber') ?? []

  if (accounts.isSuccess && sberAccounts.length === 0) {
    return (
      <main className="mx-auto w-full max-w-xl px-4 py-8">
        <h1 className="font-serif text-xl">Сначала счёт Сбера</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Отчёт заливается в счёт, и разбирается пока только выгрузка Сбера. Счёт с другим
          провайдером её не примет.
        </p>
        <Link to="/accounts/new?next=/imports" className="mt-4 inline-block text-sm text-accent">
          Завести счёт
        </Link>
      </main>
    )
  }

  return (
    <main className="mx-auto w-full max-w-2xl px-4 py-8">
      <header className="flex items-baseline justify-between">
        <h1 className="font-serif text-xl">Импорт отчёта</h1>
        <Link to="/" className="text-sm text-accent">
          Сделки
        </Link>
      </header>
      <p className="mt-1 text-sm text-ink-muted">
        XLSX «Операции» из личного кабинета Сбера. Выгрузка там ограничена периодом в год, поэтому
        историю длиннее заливайте по одному отчёту на год, начиная с самого старого: продажа не
        применится, пока в журнале нет покупки. Повторная заливка того же файла безопасна — сделки и
        движения денег не задваиваются.
      </p>

      <form
        className="mt-8 flex flex-col gap-5"
        onSubmit={(event) => {
          event.preventDefault()
          send.mutate()
        }}
      >
        <label className="flex flex-col gap-1">
          <span className="text-sm text-ink-muted">Счёт</span>
          <select
            value={accountId}
            onChange={(event) => setAccountId(event.target.value)}
            required
            className="rounded-sm border border-rule bg-surface px-2 py-1.5"
          >
            <option value="">выберите</option>
            {sberAccounts.map((account) => (
              <option key={account.id} value={account.id}>
                {accountLabel(account, sberAccounts)}
              </option>
            ))}
          </select>
        </label>

        {/* Перетаскивание — надбавка, а не единственный способ: поле выбора
            файла остаётся видимым и доступно с клавиатуры. */}
        <div
          onDragOver={(event) => {
            event.preventDefault()
            setDragging(true)
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault()
            setDragging(false)
            const dropped = event.dataTransfer.files[0]
            if (dropped) setFile(dropped)
          }}
          className={`flex flex-col gap-2 border border-dashed p-4 ${
            dragging ? 'border-accent' : 'border-rule'
          }`}
        >
          <label htmlFor={fileInputId} className="text-sm text-ink-muted">
            Перетащите файл сюда или выберите
          </label>
          <input
            id={fileInputId}
            type="file"
            accept=".xlsx"
            onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            className="text-sm"
          />
          {file ? <p className="text-sm">{file.name}</p> : null}
        </div>

        <button
          type="submit"
          disabled={accountId === '' || file === null || send.isPending}
          className="self-start rounded-sm border border-rule px-3 py-1.5 text-sm disabled:text-ink-muted"
        >
          {send.isPending ? 'Применяем' : 'Загрузить и применить'}
        </button>
      </form>

      {/* aria-live: результат появляется без перезагрузки, и экранный читатель
          должен его озвучить. */}
      <div aria-live="polite" className="mt-6">
        {send.isSuccess ? (
          <div className="border-t border-rule pt-3 text-sm">
            {send.data.status === 'failed' ? (
              // Отказ разбора приходит событием и лежит в статусе: это причина
              // от парсера, а не наш пересказ.
              <p role="alert" className="text-loss">
                Разбор отказал: {send.data.error ?? 'причина не записана'}
              </p>
            ) : send.data.status === 'parsed' && send.data.result ? (
              <>
                <p className="tabular">
                  Создано {send.data.result.created}, пропущено {send.data.result.skipped}
                </p>
                <p className="mt-1 text-ink-muted">
                  {send.data.duplicate
                    ? 'Этот файл уже загружался. Применили его снова — пропущенное и есть то, что было в журнале.'
                    : send.data.result.created === 0
                      ? 'Новых операций в отчёте не оказалось: всё уже было записано раньше.'
                      : 'Сделки, лоты, позиции и движения денег записаны.'}
                </p>
                {send.data.result.deferred > 0 ? (
                  // Не ошибка и не потеря: продажа ждёт своей покупки и
                  // применится при повторном разборе. Говорим прямо, иначе
                  // человек решит, что импорт съел сделку.
                  <div className="mt-3 border-t border-rule pt-3">
                    <p>
                      Отложено до появления покупок:{' '}
                      <span className="tabular">{send.data.result.deferred}</span>. Подробности — в
                      списке ниже.
                    </p>
                    <p className="mt-1 text-ink-muted">
                      Часть этих бумаг куплена раньше периода отчёта, и списывать продажу не с чего
                      — поэтому она отложена целиком, а купленное внутри периода пока числится в
                      портфеле. Залейте отчёт за тот год — выгрузка Сбера ограничена годом, поэтому
                      отчётов будет несколько, и начинать надо со старого. Если того года в кабинете
                      уже нет,{' '}
                      <Link to="/trades/new" className="text-accent">
                        добавьте открывающую покупку вручную
                      </Link>
                      . Потом разберите этот же отчёт снова — отложенные продажи применятся, дубли
                      не появятся.
                    </p>
                  </div>
                ) : null}
              </>
            ) : (
              // Таймаут ожидания: разбор идёт в другом процессе и мог не
              // успеть. Врать «готово» нельзя, и крутить спиннер вечно тоже.
              <p className="text-ink-muted">
                Отчёт принят, разбор ещё идёт. Обновите страницу через минуту — сделки появятся
                сами.
              </p>
            )}

            <Link to="/" className="mt-2 inline-block text-accent">
              Посмотреть сделки
            </Link>
          </div>
        ) : null}

        {send.isError ? (
          <div role="alert" className="border-t border-rule pt-3 text-sm text-loss">
            <p>{explain(send.error)}</p>
          </div>
        ) : null}
      </div>

      {byImport.size > 0 ? (
        <section className="mt-10">
          <h2 className="font-serif text-lg">Ждут покупок</h2>
          <p className="mt-1 text-sm text-ink-muted">
            Эти продажи не применены: под них нет лотов. Залейте отчёт за год, в котором бумага
            покупалась, или добавьте открывающую покупку вручную — и примените отчёт ещё раз.
            Загружать файл заново не нужно, он уже на сервере.
          </p>

          {[...byImport].map(([importId, operations]) => (
            <div key={importId} className="mt-4 border-t border-rule pt-3">
              <table className="w-full border-collapse text-sm">
                <tbody>
                  {operations.map((operation) => (
                    <tr key={operation.id} className="border-b border-rule">
                      <td className="h-8 tabular">{formatMoscowTime(operation.occurredAt)}</td>
                      <td className="h-8">{symbols.get(operation.instrumentId) ?? '—'}</td>
                      <td className="h-8">продажа</td>
                      <td className="h-8 text-right">
                        <Money
                          value={operation.quantity}
                          fractionDigits={0}
                          maxFractionDigits={18}
                        />
                      </td>
                      <td className="h-8 text-right text-ink-muted">
                        не хватает{' '}
                        <Money
                          value={operation.missing}
                          fractionDigits={0}
                          maxFractionDigits={18}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <button
                type="button"
                onClick={() => reapply.mutate(importId)}
                disabled={reapply.isPending}
                className="mt-2 rounded-sm border border-rule px-3 py-1.5 text-sm disabled:text-ink-muted"
              >
                {reapply.isPending ? 'Применяем' : 'Применить ещё раз'}
              </button>
            </div>
          ))}

          <div aria-live="polite" className="mt-3 text-sm">
            {reapply.isSuccess ? (
              <p className="tabular">
                Создано {reapply.data.result?.created ?? 0}, пропущено{' '}
                {reapply.data.result?.skipped ?? 0}
                {(reapply.data.result?.deferred ?? 0) > 0
                  ? ', часть по-прежнему ждёт покупок'
                  : ', отложенного больше нет'}
              </p>
            ) : null}
            {reapply.isError ? (
              <p role="alert" className="text-loss">
                {explain(reapply.error)}
              </p>
            ) : null}
          </div>
        </section>
      ) : null}
    </main>
  )
}
