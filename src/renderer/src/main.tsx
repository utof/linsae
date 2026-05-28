import 'katex/dist/katex.min.css'
import './styles/globals.css'
import './styles/colors_and_type.css'
import { QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './App'
import { DevFpsMeter } from './components/DevFpsMeter'
import { ErrorBoundary } from './components/ErrorBoundary'
import { queryClient } from './lib/query-client'

// StrictMode double-invokes mount effects + state initialisers in dev so
// unsafe lifecycle patterns surface immediately. Production builds strip
// StrictMode automatically; the dev overhead is the price of catching
// effect-cleanup bugs (e.g. listeners not removed, ResizeObserver leaks)
// before they ship. See issue #3 — deferred at Task 1 bootstrap, wrapped
// now that components + their effects exist.
//
// ErrorBoundary wraps App (not the QueryClientProvider) so it can catch
// render errors inside the app while leaving the provider stack intact for
// the fallback UI. Without it a render throw unmounts the whole renderer
// and the user sees a blank window — see ErrorBoundary's TSDoc for the
// specific saga that motivated this.
ReactDOM.createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </QueryClientProvider>
    {/* Dev-only FPS overlay for benchmarking scroll perf. `import.meta.env.DEV`
       is a literal `false` in production builds, so Vite tree-shakes both the
       branch and the import out of the shipped bundle. */}
    {import.meta.env.DEV && <DevFpsMeter />}
  </StrictMode>,
)
