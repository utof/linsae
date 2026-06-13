import { useSyncExternalStore } from 'react'

/**
 * DEV-only canvas LOD override store — ephemeral (in-memory, never persisted),
 * ships in prod but is inert there: the only consumers are DEV-gated HUD
 * components, and `forceTier` defaults to 'auto' so production render is
 * unaffected even if the store were somehow reached.
 *
 * Same rationale as devOverlays.ts: a hand-rolled useSyncExternalStore store
 * avoids a new dependency and works across sibling React sub-trees (the HUD
 * lives outside the canvas subtree). The module must ship in prod because hooks
 * obey rules-of-hooks — they can't be conditional on `import.meta.env.DEV`.
 * The overlay *components* remain DEV-gated (never in the production bundle).
 *
 * Why NOT persisted (contrast with devOverlays fps/boot/wave):
 *   forceTier, unclampZoom, and syntheticDots are session debug toggles.
 *   Persisting them would cause a confusing non-card canvas on the next cold
 *   start if the developer forgot to reset before closing.
 *
 * @see src/renderer/src/dev/devOverlays.ts
 * @see docs/specs/v0.4-canvas-mvp.md §12
 */

/** Tier override for the canvas LOD dev HUD. 'auto' uses `tierForZoom`. */
export interface CanvasDevLod {
  /** 'auto' → use `tierForZoom(zoom)`; 'card' / 'dot' → force that tier. */
  forceTier: 'auto' | 'card' | 'dot'
  /**
   * When true, threads `unclampZoom: true` into useCanvasCamera so zoom can
   * exceed the [0.5, 2.0] production clamp — exposing sub-threshold tiers.
   */
  unclampZoom: boolean
  /**
   * When true, the dot tier renders 10k synthetic random dots (not the real
   * placed-note positions) — used for dot-layer performance testing without
   * needing a large note corpus.
   */
  syntheticDots: boolean
}

const DEFAULT: CanvasDevLod = {
  forceTier: 'auto',
  unclampZoom: false,
  syntheticDots: false,
}

let state: CanvasDevLod = { ...DEFAULT }
const listeners = new Set<() => void>()

/**
 * Current canvas LOD dev state (snapshot).
 * Why: useSyncExternalStore requires a `getSnapshot` function; components that
 * need the value outside React (e.g. CanvasStage's render path) can call this
 * directly.
 * @see devOverlays.ts#getOverlay
 */
export function getCanvasDevLod(): CanvasDevLod {
  return state
}

/**
 * Merge a partial update into the LOD store and notify all subscribers.
 * @param patch - Partial CanvasDevLod; missing keys keep their current values.
 * @see devOverlays.ts#setOverlay
 */
export function setCanvasDevLod(patch: Partial<CanvasDevLod>): void {
  state = { ...state, ...patch }
  for (const l of listeners) l()
}

/**
 * Register a listener that fires after each `setCanvasDevLod` call. Returns an
 * unsubscribe function. Exported so unit tests can verify notification without
 * a React host (useSyncExternalStore requires a renderer).
 * @see src/renderer/src/dev/devOverlays.ts — same pattern, unexported there because
 *   the overlay store test drives it through the React hook; LOD test is node-env only.
 */
export function subscribeCanvasDevLod(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

/**
 * Subscribe a component to the canvas LOD dev state. Re-renders on every
 * `setCanvasDevLod` call. Uses the same snapshot for client and server to avoid
 * hydration mismatches (the DEV HUD is renderer-only; no SSR concern in practice,
 * but the API requires a server snapshot).
 * @see src/renderer/src/dev/devOverlays.ts#useDevOverlay
 */
export function useCanvasDevLod(): CanvasDevLod {
  return useSyncExternalStore(subscribeCanvasDevLod, getCanvasDevLod, () => DEFAULT)
}
