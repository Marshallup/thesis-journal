import { Navigate, Route, Routes } from 'react-router'
import { AccountForm } from './pages/accounts/new/account-form.tsx'
import { DecisionForm } from './pages/decision-new/decision-form.tsx'
import { DecisionsPage } from './pages/decisions/decisions-page.tsx'
import { LoginPage } from './pages/login/login-page.tsx'
import { TradeForm } from './pages/trades/new/trade-form.tsx'
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
        path="/accounts/new"
        element={state === 'authenticated' ? <AccountForm /> : <Navigate to="/login" replace />}
      />
      <Route
        path="/trades/new"
        element={state === 'authenticated' ? <TradeForm /> : <Navigate to="/login" replace />}
      />
      <Route
        path="/decisions"
        element={state === 'authenticated' ? <DecisionsPage /> : <Navigate to="/login" replace />}
      />
      <Route
        path="/decisions/new"
        element={state === 'authenticated' ? <DecisionForm /> : <Navigate to="/login" replace />}
      />
    </Routes>
  )
}
