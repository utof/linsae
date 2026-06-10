import { useSyncExternalStore } from 'react'

/**
 * DEV-only overlay visibility store — single source of truth for which dev overlays
 * (fps / boot / wave / reveal) are shown. Read live via {@link useDevOverlay} from both
 * render roots (main.tsx fps/boot, App.tsx wave/reveal) and the DevToolsHud panel, so a
 * toggle re-renders every consumer with no reload.
 *
 * Why a hand-rolled external store (not context/zustand): zero new dep (useSyncExternalStore
 * is React 19 built-in), and it works across main.tsx's two sibling subtrees (fps lives
 * outside QueryClientProvider) without threading a provider through both.
 *
 * Why this module ships in prod (overlays don't): App must call the reveal hook
 * unconditionally (rules of hooks) and the VITE_PLAYGROUND harness runs with DEV=false, so the
 * hook can't be DEV-gated. The module is tiny + inert in prod; the overlay *components* stay
 * tree-shaken behind `import.meta.env.DEV ? lazy(...) : null`.
 * @see docs/specs/v0.2.4-dev-tools-hud.md
 * @see adrs/0024-dev-tools-hud.md
 */
export type DevOverlayKey = 'fps' | 'boot' | 'wave' | 'reveal'

const PERSISTED: Record<Exclude<DevOverlayKey, 'reveal'>, string> = {
  fps: 'devfpsmeter',
  boot: 'devbootmeter',
  wave: 'wavetuner',
}
const DEFAULTS: Record<DevOverlayKey, boolean> = {
  fps: true,
  boot: false,
  wave: false,
  reveal: false,
}

// reveal is session-ephemeral — a modal must not resurrect itself on reload.
const ephemeral: Record<'reveal', boolean> = { reveal: DEFAULTS.reveal }
const listeners = new Set<() => void>()

/** Current on/off state for one overlay (reads localStorage for fps/boot/wave). @see module doc above */
export function getOverlay(key: DevOverlayKey): boolean {
  if (key === 'reveal') return ephemeral.reveal
  try {
    const raw = localStorage.getItem(PERSISTED[key])
    if (raw === null) return DEFAULTS[key]
    return raw !== '0' && raw !== ''
  } catch {
    return DEFAULTS[key]
  }
}

/** Set one overlay on/off (persists fps/boot/wave to localStorage; reveal in-memory) + notify. @see module doc above */
export function setOverlay(key: DevOverlayKey, on: boolean): void {
  if (key === 'reveal') {
    ephemeral.reveal = on
  } else {
    try {
      localStorage.setItem(PERSISTED[key], on ? '1' : '0')
    } catch {
      // best-effort: a dev tool must never crash the app (private-mode localStorage quirks)
    }
  }
  for (const l of listeners) l()
}

/** Flip one overlay's state. @see module doc above */
export function toggleOverlay(key: DevOverlayKey): void {
  setOverlay(key, !getOverlay(key))
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

/** Subscribe a component to one overlay's on/off state. Re-renders on any `setOverlay`. @see ./devOverlays module doc above */
export function useDevOverlay(key: DevOverlayKey): boolean {
  return useSyncExternalStore(
    subscribe,
    () => getOverlay(key),
    () => DEFAULTS[key],
  )
}
