import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useId, useState } from 'react'
import { Link } from 'react-router'
import { ApiError, api } from '../../shared/api/client.ts'
import { accountLabel } from '../../shared/ui/account-label.ts'
import type { LabelledAccount } from '../../shared/ui/account-label.ts'

type Account = LabelledAccount
type Upload = { importId: string; status: 'pending' | 'duplicate' }
type Applied = { created: number; skipped: number; duplicate: boolean }

// Отказы бэкенда, которые человек должен понять без чтения логов. 409 приходит
// без текста — это состояние, а не ошибка формы; у 400 текст есть, и он
// полезнее любого нашего пересказа.
function explain(error: unknown): { text: string; fixable: boolean } {
  if (error instanceof ApiError && error.status === 409) {
    return {
      text: 'Отчёт по этому счёту уже применяется. Подождите и попробуйте снова.',
      fixable: false,
    }
  }
  if (error instanceof ApiError && error.status === 400) {
    return { text: error.message, fixable: error.message.includes('без покупок') }
  }
  return { text: 'Не получилось. Попробуйте ещё раз.', fixable: false }
}

export function ImportPage() {
  const queryClient = useQueryClient()
  const fileInputId = useId()

  const accounts = useQuery({ queryKey: ['accounts'], queryFn: () => api<Account[]>('/accounts') })
  const [accountId, setAccountId] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [dragging, setDragging] = useState(false)

  const send = useMutation<Applied>({
    mutationFn: async () => {
      if (!file) throw new Error('файл не выбран')
      const form = new FormData()
      form.append('file', file)
      form.append('accountId', accountId)

      // Два запроса, а не один: заливка сохраняет отчёт целиком, применение
      // разбирает. Если разбор упадёт, файл уже лежит на сервере, и повторять
      // придётся только применение.
      const uploaded = await api<Upload>('/imports', { method: 'POST', body: form })
      const applied = await api<{ created: number; skipped: number }>(
        `/imports/${uploaded.importId}/apply`,
        { method: 'POST' },
      )
      return { ...applied, duplicate: uploaded.status === 'duplicate' }
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['trades'] })
    },
  })

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
        XLSX «Операции» из личного кабинета Сбера. Повторная заливка того же файла безопасна: сделки
        и движения денег не задваиваются.
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
            <p className="tabular">
              Создано {send.data.created}, пропущено {send.data.skipped}
            </p>
            <p className="mt-1 text-ink-muted">
              {send.data.duplicate
                ? 'Этот файл уже загружался. Применили его снова — пропущенное и есть то, что было в журнале.'
                : send.data.created === 0
                  ? 'Новых операций в отчёте не оказалось: всё уже было записано раньше.'
                  : 'Сделки, лоты, позиции и движения денег записаны.'}
            </p>
            <Link to="/" className="mt-2 inline-block text-accent">
              Посмотреть сделки
            </Link>
          </div>
        ) : null}

        {send.isError ? (
          <div role="alert" className="border-t border-rule pt-3 text-sm text-loss">
            <p>{explain(send.error).text}</p>
            {explain(send.error).fixable ? (
              <p className="mt-1 text-ink-muted">
                Бумага куплена раньше начала периода отчёта, поэтому лотов под продажу нет.{' '}
                <Link to="/trades/new" className="text-accent">
                  Добавьте открывающую покупку
                </Link>{' '}
                — её цену знаете только вы — и повторите импорт.
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    </main>
  )
}
