/**
 * Process-local per-note rendered-height cache.
 *
 * Why this exists: the OSS react-virtuoso doesn't expose a stable
 * total-height signal for chat-style variable-content lists — its internal
 * `scrollHeight` swaps each unmeasured item's wild placeholder estimate
 * for the real measured size as items enter viewport. Each swap jerks
 * anything bound to `scrollHeight` (our custom scrollbar thumb).
 * Maintainer-confirmed at petyosi/react-virtuoso#1240 / #131 / #428 / #1382
 * — the only "real fix" the project ships is the commercial MessageList
 * component, which spec §Stack rules out.
 *
 * The workaround: stop reading the DOM scrollHeight in `useScrollThumb`,
 * and derive the thumb total from the sum of *real* per-note heights we
 * observe ourselves via a ResizeObserver inside each rendered bubble. The
 * cache only grows monotonically with real measurements — there is no
 * estimate→measure swap because the cache *is* the truth. When a bubble
 * re-mounts (e.g., due to Virtuoso virtualization) and re-measures, the
 * value is identical so `recordMeasurement` short-circuits and no React
 * re-render is triggered.
 *
 * Lifetime: module-singleton, lives for the renderer process. Entries are
 * NOT cleared on Virtuoso virtualization unmount (that's the whole point —
 * we want measurements to survive scroll-out-of-viewport). They are
 * cleared explicitly via `clearMeasurement` when a note is deleted.
 *
 * Subscription: `useSyncExternalStore`-compatible `subscribe` + `getTick`
 * pair lets components re-derive when the cache mutates.
 *
 * @see adrs/0004-feed-thumb-measurement-cache.md (TODO if we keep this)
 * @see https://github.com/petyosi/react-virtuoso/discussions/1083
 */

const cache = new Map<string, number>()
const listeners = new Set<() => void>()
let tick = 0
let bumpScheduled = false

/**
 * Microtask-coalesce the listener notification so a burst of synchronous
 * `recordMeasurement` calls (e.g. many MeasuredBubble ResizeObservers firing
 * their initial entries as the user scrolls a stream of new items into
 * viewport) collapses to ONE `tick` increment and ONE re-render.
 *
 * Why: without batching, every cache mutation increments `tick` and
 * synchronously notifies the `useSyncExternalStore` subscription in `Feed`.
 * React reads the snapshot after each commit's passive effects; if the
 * snapshot keeps changing on every commit (because newly-mounted bubbles
 * keep firing RO microtasks that bump the tick), React schedules another
 * render, more mounts run, more ROs fire, until the ~50-update depth limit
 * trips with "Maximum update depth exceeded" and the renderer unmounts —
 * blank GUI. Coalescing into a single microtask collapses the burst into
 * one stable snapshot change per turn.
 *
 * Correctness: by the time the microtask runs, every `cache.set` from the
 * burst is already committed (synchronous Map writes), so `modelTotal`'s
 * recomputation in the resulting re-render sees the full updated state.
 *
 * @see https://github.com/utof/linsae diagnosis of v0.1.2-polish phase
 */
function bump(): void {
  if (bumpScheduled) return
  bumpScheduled = true
  queueMicrotask(() => {
    bumpScheduled = false
    tick++
    for (const l of listeners) l()
  })
}

/**
 * Record a bubble's measured rendered height. No-ops when the height
 * matches the cached value (avoids spurious re-renders during virtualization
 * remount cycles where the bubble's size hasn't changed).
 */
export function recordMeasurement(id: string, height: number): void {
  if (cache.get(id) === height) return
  cache.set(id, height)
  bump()
}

/**
 * Remove a bubble's cached height. Called when a note is deleted from the
 * data — NOT on Virtuoso virtualization unmount. Distinguishing requires
 * the caller to know the difference; Feed does (it owns the notes array).
 */
export function clearMeasurement(id: string): void {
  if (!cache.delete(id)) return
  bump()
}

export function getCachedHeight(id: string): number | undefined {
  return cache.get(id)
}

export function subscribeMeasurements(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Monotonically-increasing tick incremented on every cache mutation —
 * `useSyncExternalStore`'s `getSnapshot` requires a stable scalar so React
 * can dedupe. Reading the Map itself wouldn't work because the same Map
 * reference is reused across mutations.
 */
export function getMeasurementTick(): number {
  return tick
}
