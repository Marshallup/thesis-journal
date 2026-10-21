import { useState } from 'react'
import { useSession } from '../../shared/api/session.tsx'

export function LoginPage() {
  const { signIn } = useSession()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setError(null)
    setBusy(true)
    try {
      await signIn(email, password)
    } catch {
      // Причину не уточняем: «такого адреса нет» подсказывает перебор.
      setError('Не удалось войти. Проверьте адрес и пароль.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-sm flex-col justify-center px-4">
      <h1 className="font-serif text-xl">Тезис</h1>
      <p className="mt-1 text-sm text-ink-muted">Дневник инвестиционных решений</p>

      <form onSubmit={submit} className="mt-8 flex flex-col gap-4">
        <label className="flex flex-col gap-1">
          <span className="text-sm text-ink-muted">Почта</span>
          <input
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            autoComplete="username"
            required
            className="rounded-sm border border-rule bg-surface px-2 py-1.5 outline-none focus-visible:border-accent"
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-sm text-ink-muted">Пароль</span>
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
            required
            className="rounded-sm border border-rule bg-surface px-2 py-1.5 outline-none focus-visible:border-accent"
          />
        </label>

        {error ? (
          <p role="alert" className="text-sm text-loss">
            {error}
          </p>
        ) : null}

        <button
          type="submit"
          disabled={busy}
          className="rounded-sm bg-accent px-3 py-1.5 text-paper disabled:opacity-60"
        >
          {busy ? 'Входим' : 'Войти'}
        </button>
      </form>
    </main>
  )
}
