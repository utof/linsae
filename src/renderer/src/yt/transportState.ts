import { useEffect } from 'react'
import { create } from 'zustand'

/**
 * Playback-rate cycle, in order. Literal sequence mandated by
 * docs/plans/v0.8.2-composer-dataloss.md §3.2 ("do not re-invent") — it restores
 * the `RATES` array that lived in `ThreadView` before commit 4ab51f0 deleted it.
 */
const RATES = [1, 1.25, 1.5, 1.75, 2]

/** Fallback rate, and the initial one. Also the resync target for an off-sequence rate. */
const DEFAULT_RATE = 1

/**
 * Shared frozen-by-convention empty array used as both the initial `markers` value
 * and the value `clearMarkers` restores, so repeated clears keep one reference and
 * never re-render subscribers. Never mutate it.
 */
const NO_MARKERS: number[] = []

// Local interface — NOT exported until a consumer needs the type. Exporting an
// unused type fails the precommit knip gate (see pdf/excerptState.ts:4-5).
interface TransportState {
  /**
   * Whether the "follow playback" scroll lock is active. Drives `ThreadView`'s
   * follow auto-scroll and `jumpPillDirection`, not just a button colour.
   * Defaults `true` to match the `const followOn = true` hardcode B3 replaces.
   */
  followOn: boolean
  /** Current playback rate. Always a member of `RATES` unless something else set it. */
  rate: number
  /**
   * Absolute positions in seconds for the scrubber's marker ticks. Matches
   * `TransportBarProps.markers` (thread/TransportBar.tsx:26-27) exactly.
   * THREAD-scoped: `ThreadView` is the sole publisher — see the store TSDoc.
   */
  markers: number[]
  /** Toggle the follow-playback scroll lock. Wired to `TransportBarProps.onToggleFollow`. */
  toggleFollow: () => void
  /**
   * Advance to the next rate in `RATES`, wrapping, and RETURN the new rate.
   *
   * Why it returns the value: the store must stay side-effect-free, but B2 also has
   * to push the rate at the player (`player.setPlaybackRate(next)`). Returning the
   * new rate lets `onRate={() => player.setPlaybackRate(cycleRate())}` stay a
   * one-liner instead of re-reading the store after a `set`.
   */
  cycleRate: () => number
  /**
   * Publish the thread's marker timestamps. No-ops when the values are unchanged,
   * so a republishing effect cannot churn subscribers' references. Retains the
   * caller's array by reference — publish a FRESH array; an in-place mutation of an
   * already-published one compares equal to itself and is therefore invisible.
   */
  setMarkers: (next: number[]) => void
  /** Drop all markers. Idempotent and reference-stable. */
  clearMarkers: () => void
}

/**
 * Transport store — the cross-pane bridge that lets `PlayerPane` (right dock) render
 * a working `TransportBar` again after the v0.6.4 B5 lift stripped it from
 * `ThreadView`. The two panes are SIBLINGS, so pane-local state cannot carry
 * `followOn` or `markers` between them; a store can.
 *
 * Client UI state only, no DB state — same shape as `pdf/excerptState.ts` and
 * `pdf/pendingJumpState.ts`. Deliberately side-effect-free: it never touches the
 * player singleton, so it stays testable without a YouTube iframe and cannot
 * violate the single-mount invariant (ADR 0016).
 *
 * **Two lifetimes, deliberately — B2/B3 depend on this:**
 * - `followOn` / `rate` are PLAYER-scoped preferences. They have NO reset: they must
 *   survive `ThreadView` unmounting while the docked player keeps playing, which is
 *   the entire point of the B5 lift.
 *
 *   **"Player-scoped" names THIS STORE's lifetime, not the player's.** `rate` is held
 *   ONLY here: `load(id)` reassigns the webview's `src` (`playerSingleton.ts`'s `load`),
 *   a full guest reload, which destroys the `<video>` that the guest's `setRate`
 *   handler writes to (`yt/inject/youtube-guest.ts`'s `initPort`), and `Player` exposes no
 *   `getPlaybackRate()` to read the truth back. The store never pushes. Re-pushing on
 *   video change is therefore the CONSUMER's standing obligation; without it the badge
 *   and actual playback diverge silently.
 *
 *   **Copy `PlayerPane.tsx`'s effect, not the obvious one.** Keying it on
 *   `[videoId, rate]` alone is inert: `load()` calls `teardown()`, which destroys and
 *   nulls `rpc`, BEFORE reassigning `src`, and `setPlaybackRate` is
 *   `rpc?.invoke('setRate', r)` (`playerSingleton.ts`'s `setPlaybackRate`), so the push
 *   fired at videoId-change time is swallowed by the optional chain. The deps must also
 *   carry the player `state` — a guest state event is the only public signal that the
 *   reloaded port is live. See `PlayerPane.tsx`'s rate re-push effect, and
 *   `PlayerPane.test.tsx`'s `(n)`, which covers exactly that path.
 * - `markers` are THREAD-scoped, and `useMarkerPublisher` below owns that lifecycle —
 *   NOT the caller. `ThreadView` is the sole publisher and calls the hook; the hook
 *   republishes on change and clears on unmount, so one thread's ticks can never appear
 *   on the next video's scrubber. Do not hand-roll it: the clear belongs in its own
 *   effect, and folding it into the publish effect's cleanup empties the list on every
 *   republish (see the hook's own TSDoc). Keeping this a publisher obligation avoids
 *   keying the store by `videoId`, which the plan's "small store" (§3.2) does not ask for.
 *
 * @see docs/plans/v0.8.2-composer-dataloss.md §3.2–3.3
 * @see src/renderer/src/thread/TransportBar.tsx (the props this feeds)
 * @issue utof/linsae#169
 */
export const useTransportStore = create<TransportState>((set, get) => ({
  followOn: true,
  rate: DEFAULT_RATE,
  markers: NO_MARKERS,

  toggleFollow: () => set((s) => ({ followOn: !s.followOn })),

  cycleRate: () => {
    // indexOf → -1 for a rate that is not in the sequence, and (-1 + 1) % len === 0,
    // so an off-sequence rate resyncs to RATES[0] rather than wedging the cycle.
    const i = RATES.indexOf(get().rate)
    // ?? DEFAULT_RATE only satisfies noUncheckedIndexedAccess; the modulo makes the
    // index provably in-range.
    const next = RATES[(i + 1) % RATES.length] ?? DEFAULT_RATE
    set({ rate: next })
    return next
  },

  setMarkers: (next) => {
    const current = get().markers
    // Value-equality bail-out: B3 republishes from an effect whose deps include the
    // ~5 Hz-polled duration, so an unconditional set would hand PlayerPane a new
    // array identity several times a second and re-render the transport for nothing.
    if (current.length === next.length && current.every((t, i) => t === next[i])) return
    set({ markers: next })
  },

  clearMarkers: () => set({ markers: NO_MARKERS }),
}))

/**
 * Publishes `markers` for the calling component's lifetime and CLEARS them when it
 * unmounts. `ThreadView` is the sole publisher; this hook exists so that publishing
 * and teardown cannot be separated — B1 could only state that pairing in prose, and a
 * prose-only contract is exactly what rotted for two milestones and produced #169.
 *
 * Without the teardown, one thread's tick marks stay on the docked scrubber over the
 * NEXT video (`markers` are thread-scoped; `followOn`/`rate` deliberately are not).
 *
 * Two effects, not one: folding the clear into the publish effect's cleanup would
 * empty the list on every republish — a visible flicker on the scrubber and two store
 * writes where one belongs.
 *
 * Reads the store through `getState()` rather than a selector: the publisher must NOT
 * re-render when the markers it just published come back around.
 *
 * @param markers - Fresh array of absolute positions in seconds. `setMarkers` retains
 *   it by reference and bails on value-equality, so an unmemoized caller is safe — but
 *   NEVER mutate an array already handed to this hook.
 * @see src/renderer/src/thread/ThreadView.tsx (the sole caller)
 * @issue utof/linsae#169
 */
export function useMarkerPublisher(markers: number[]): void {
  useEffect(() => {
    useTransportStore.getState().setMarkers(markers)
  }, [markers])

  useEffect(
    () => () => {
      useTransportStore.getState().clearMarkers()
    },
    [],
  )
}
