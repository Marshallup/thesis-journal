import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { api, refreshSession, setAccessToken } from './client.ts'

type State = 'checking' | 'anonymous' | 'authenticated'

type Session = {
  state: State
  signIn: (email: string, password: string) => Promise<void>
  signOut: () => void
}

const SessionContext = createContext<Session | null>(null)

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>('checking')

  // При загрузке страницы access-токена в памяти нет, но refresh-cookie жива —
  // отсюда «обновил страницу, а сессия на месте».
  useEffect(() => {
    let cancelled = false
    void refreshSession().then((restored) => {
      if (!cancelled) setState(restored ? 'authenticated' : 'anonymous')
    })
    return () => {
      cancelled = true
    }
  }, [])

  const signIn = useCallback(async (email: string, password: string) => {
    const { accessToken } = await api<{ accessToken: string }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    })
    setAccessToken(accessToken)
    setState('authenticated')
  }, [])

  const signOut = useCallback(() => {
    setAccessToken(null)
    setState('anonymous')
  }, [])

  return (
    <SessionContext.Provider value={{ state, signIn, signOut }}>{children}</SessionContext.Provider>
  )
}

export function useSession(): Session {
  const session = useContext(SessionContext)
  if (!session) throw new Error('useSession вне SessionProvider')
  return session
}
