import { Navigate, Route, Routes } from 'react-router'
import { DecisionForm } from './pages/decision-new/decision-form.tsx'
import { LoginPage } from './pages/login/login-page.tsx'
import { TradesPage } from './pages/trades/trades-page.tsx'
import { useSession } from './shared/api/session.tsx'

export function App() {
  const { state } = useSession()

  // Пока сессия восстанавливается из refresh-cookie, рисовать нечего: иначе
  // на миг мелькнёт логин у человека, который уже вошёл.
  if (state === 'checking') return null

  return (
    <Routes>
      <Route
        path="/login"
        element={state === 'authenticated' ? <Navigate to="/" replace /> : <LoginPage />}
      />
      <Route
        path="/"
        element={state === 'authenticated' ? <TradesPage /> : <Navigate to="/login" replace />}
      />
      <Route
        path="/decisions/new"
        element={state === 'authenticated' ? <DecisionForm /> : <Navigate to="/login" replace />}
      />
    </Routes>
  )
}
