import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import App from './App.tsx'

/**
 * One query client for the whole app.
 *
 * `refetchOnWindowFocus` is off on purpose: the server pushes changes over SSE,
 * so refetching every time the window regains focus is traffic that buys
 * nothing. Retries are capped at one — a server that is down should say so
 * quickly rather than leave the UI spinning.
 */
const queryClient = new QueryClient({
  defaultOptions: {
    queries: { refetchOnWindowFocus: false, retry: 1 },
  },
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
)
