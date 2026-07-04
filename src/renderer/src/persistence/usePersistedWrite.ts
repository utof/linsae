import { useEffect, useRef } from 'react'
import { api } from '../lib/api'

/** Debounced, cancellable write-through of `value` to an app_settings key. Writes only
 *  when `enabled` (i.e. after boot hydration, so the hydrated value isn't echoed).
 *  Flushes any pending write on `visibilitychange`→hidden (the reliable last-chance in
 *  an Electron renderer; beforeunload async IPC is best-effort). @see spec §Write-through
 *  Note: unmount or `enabled`→false mid-debounce drops the pending write; every v0.7 caller
 *  lives in the long-lived App, so this never fires in practice. */
export function usePersistedWrite<T>(
  key: string,
  value: T,
  opts: { debounceMs: number; enabled: boolean },
): void {
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const pending = useRef<{ has: boolean; value: T }>({ has: false, value })
  const first = useRef(true)

  useEffect(() => {
    if (!opts.enabled) return
    if (first.current) {
      first.current = false
      return
    } // don't write the initial (hydrated) value
    pending.current = { has: true, value }
    clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      pending.current.has = false
      void api.settings.set(key, value)
    }, opts.debounceMs)
    return () => clearTimeout(timer.current)
  }, [key, value, opts.enabled, opts.debounceMs])

  useEffect(() => {
    const flush = () => {
      if (document.hidden && pending.current.has) {
        clearTimeout(timer.current)
        pending.current.has = false
        void api.settings.set(key, pending.current.value)
      }
    }
    document.addEventListener('visibilitychange', flush)
    return () => document.removeEventListener('visibilitychange', flush)
  }, [key])
}
