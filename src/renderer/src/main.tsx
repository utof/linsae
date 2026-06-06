import 'katex/dist/katex.min.css'
import './styles/globals.css'
import './styles/colors_and_type.css'
import { QueryClientProvider } from '@tanstack/react-query'
import { Fragment, StrictMode } from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './App'
import { DevBootMeter } from './components/DevBootMeter'
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
// Dev escape hatch (GH #49): StrictMode's double-render of the feed morph's
// per-frame flushSync adds a ~40-60ms freeze at the start of expand/collapse
// in dev only (gone in prod — see GH #48). Set `localStorage.noStrict = 1` and
// reload to drop StrictMode while tuning animation feel; unset it to restore
// the bug-detection. Defaults to ON; the whole branch is `import.meta.env.DEV`-
// gated so production is always wrapped in real StrictMode.
//
// ErrorBoundary wraps App (not the QueryClientProvider) so it can catch
// render errors inside the app while leaving the provider stack intact for
// the fallback UI. Without it a render throw unmounts the whole renderer
// and the user sees a blank window — see ErrorBoundary's TSDoc for the
// specific saga that motivated this.
const Strict = import.meta.env.DEV && localStorage.noStrict ? Fragment : StrictMode
if (import.meta.env.DEV) {
  // So the toggle's effect is visible on each dev reload (noStrict is read here,
  // at boot, NOT live — you must reload after setting/clearing it). See GH #49.
  console.info(
    `[linsae] React.StrictMode ${Strict === StrictMode ? 'ON' : 'OFF (localStorage.noStrict set)'} — set/clear localStorage.noStrict then reload to toggle`,
  )
}
ReactDOM.createRoot(document.getElementById('root')!).render(
  <Strict>
    <QueryClientProvider client={queryClient}>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
      {/* Dev-only boot timeline readout (bottom-right): FCP / DOMContentLoaded /
         notes-query resolution — the renderer-side counterpart to the main
         process `[boot]` logs. MUST be inside QueryClientProvider: it reads the
         ['notes'] query via useQuery, so mounting it outside throws "No
         QueryClient set"; being outside the ErrorBoundary too, that throw would
         crash the whole render and leave the boot splash stuck. DEV-gated so
         Vite tree-shakes it (and the import) from prod. */}
      {import.meta.env.DEV && <DevBootMeter />}
    </QueryClientProvider>
    {/* Dev-only FPS overlay for benchmarking scroll perf. `import.meta.env.DEV`
       is a literal `false` in production builds, so Vite tree-shakes both the
       branch and the import out of the shipped bundle. */}
    {import.meta.env.DEV && <DevFpsMeter />}
  </Strict>,
)
