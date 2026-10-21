import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router'
import { App } from './app.tsx'
import { SessionProvider } from './shared/api/session.tsx'
import './styles/theme.css'

const root = document.getElementById('root')
if (!root) throw new Error('нет #root в index.html')

// retry: false — повтор уже делает интерцептор клиента, и ровно один раз.
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <SessionProvider>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </SessionProvider>
    </QueryClientProvider>
  </StrictMode>,
)
