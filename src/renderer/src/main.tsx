import 'katex/dist/katex.min.css'
import './styles/globals.css'
import './styles/colors_and_type.css'
import { QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './App'
import { queryClient } from './lib/query-client'

// StrictMode double-invokes mount effects + state initialisers in dev so
// unsafe lifecycle patterns surface immediately. Production builds strip
// StrictMode automatically; the dev overhead is the price of catching
// effect-cleanup bugs (e.g. listeners not removed, ResizeObserver leaks)
// before they ship. See issue #3 — deferred at Task 1 bootstrap, wrapped
// now that components + their effects exist.
ReactDOM.createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
)
