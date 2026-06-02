/**
 * 12h / 24h wall-clock display preference, persisted in localStorage and shared
 * across the renderer. Only WALL-CLOCK timestamps read this (feed bubble footers,
 * the video card's created-at). The playback clock (m:ss / h:mm:ss in lib/time.ts)
 * is duration, not time-of-day, so it is unaffected.
 *
 * Default is 12-hour (matches the locale the app currently renders for the user —
 * see the "11:09 PM" feed timestamps); checking the Settings toggle switches to 24h.
 *
 * Why a custom event + hook rather than a bare getter: toggling the setting has to
 * re-render already-painted timestamps live. The DOM `storage` event only fires in
 * OTHER tabs, so we dispatch our own same-document event on write and `useClock24`
 * subscribes to it.
 *
 * @see src/renderer/src/settings/SettingsPanel.tsx (the toggle)
 * @see src/renderer/src/feed/NoteBubble.tsx / MediaFeedNote.tsx (consumers)
 */
import { useEffect, useState } from 'react'

const KEY = 'linsae.clock24'
const EVENT = 'linsae:clock-pref'

/** True when the user prefers 24-hour time. Defaults to false (12-hour). */
export function isClock24(): boolean {
  return localStorage.getItem(KEY) === '1'
}

/** Persist the preference and notify same-document subscribers (`useClock24`). */
export function setClock24(on: boolean): void {
  localStorage.setItem(KEY, on ? '1' : '0')
  window.dispatchEvent(new Event(EVENT))
}

/** Reactive read of {@link isClock24} — re-renders the caller when the pref changes. */
export function useClock24(): boolean {
  const [v, setV] = useState(isClock24)
  useEffect(() => {
    const handler = () => setV(isClock24())
    window.addEventListener(EVENT, handler)
    return () => window.removeEventListener(EVENT, handler)
  }, [])
  return v
}
