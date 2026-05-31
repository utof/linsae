import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { api } from '../lib/api'

/**
 * Dev-only boot timeline readout (bottom-right). Surfaces the renderer-side
 * startup costs the main-process `[boot]` logs can't see: first contentful
 * paint (when the #boot-splash skeleton actually painted), DOMContentLoaded
 * (after the deferred module graph executed), and how long until the notes
 * query resolved. Mounted only under `import.meta.env.DEV` (see `main.tsx`);
 * Vite strips the dead branch + tree-shakes this module from prod.
 *
 * Why: the 4.2s cold-`pnpm dev` first paint is a Vite-dev-server cost (module
 * transform + the Babel react-compiler pass + Chromium eval), invisible to the
 * main-process timeline. FCP here is the splash-paint moment — the number that
 * tells us whether the static splash is appearing early or stuck behind the
 * compile. This is the in-app measurement loop for the dev-startup tuning
 * tracked alongside the boot-splash work; pairs with the main `[boot]` marks.
 *
 * Why Performance API (not React state timers): `first-contentful-paint` and
 * the navigation timing are recorded by Chromium against navigation start
 * (`performance.timeOrigin`), so they're correct even though this component
 * mounts late (after the module graph finishes). `performance.now()` at the
 * notes-query success is likewise ms-since-navigation, capturing the full
 * compile→IPC→data path.
 *
 * @see src/main/index.ts ([boot] timeline)
 * @see src/renderer/index.html (#boot-splash)
 * @see src/renderer/src/components/DevFpsMeter.tsx (sibling dev overlay)
 */
function paintMs(name: string): number | null {
  const e = performance.getEntriesByType('paint').find((p) => p.name === name)
  return e ? Math.round(e.startTime) : null
}

function domContentLoadedMs(): number | null {
  const nav = performance.getEntriesByType('navigation')[0] as
    | PerformanceNavigationTiming
    | undefined
  return nav ? Math.round(nav.domContentLoadedEventEnd) : null
}

export function DevBootMeter(): React.JSX.Element {
  const { status, data } = useQuery({ queryKey: ['notes'], queryFn: () => api.notes.list() })
  const [notesMs, setNotesMs] = useState<number | null>(null)
  const [fcp, setFcp] = useState<number | null>(() => paintMs('first-contentful-paint'))
  useEffect(() => {
    // Freeze the first success time (subsequent invalidations would overwrite it
    // with re-fetch times that aren't boot costs).
    if (status === 'success' && notesMs === null) setNotesMs(Math.round(performance.now()))
  }, [status, notesMs])
  useEffect(() => {
    if (fcp != null) return
    // FCP lands in the performance buffer ASYNCHRONOUSLY — typically after this
    // overlay's first sync renders (which fire on mount + notes-resolved), so
    // reading it inline left it stuck on "…". Observe it instead; `buffered:true`
    // replays an entry recorded before the observer attached.
    let obs: PerformanceObserver | undefined
    try {
      obs = new PerformanceObserver((list) => {
        const e = list.getEntriesByName('first-contentful-paint')[0]
        if (e) setFcp(Math.round(e.startTime))
      })
      obs.observe({ type: 'paint', buffered: true })
    } catch {
      // paint timing unsupported in this runtime — leave fcp null ("…")
    }
    return () => obs?.disconnect()
  }, [fcp])

  const dcl = domContentLoadedMs()
  const count = data?.length ?? 0
  const notesCell = status === 'success' ? `${count} · ${notesMs ?? '…'}ms` : status

  const row = (label: string, value: string) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
      <span style={{ opacity: 0.6 }}>{label}</span>
      <span style={{ fontVariantNumeric: 'tabular-nums' }}>{value}</span>
    </div>
  )

  return (
    <div
      aria-hidden
      style={{
        position: 'fixed',
        bottom: 8,
        right: 8,
        zIndex: 99999,
        pointerEvents: 'none',
        minWidth: 124,
        background: 'rgba(0,0,0,0.62)',
        padding: '5px 8px',
        borderRadius: 5,
        fontFamily: 'var(--font-mono, monospace)',
        fontSize: 11,
        lineHeight: 1.5,
        color: '#fff',
        userSelect: 'none',
      }}
    >
      {row('fcp', fcp != null ? `${fcp}ms` : '…')}
      {row('dcl', dcl != null ? `${dcl}ms` : '…')}
      {row('notes', notesCell)}
    </div>
  )
}
