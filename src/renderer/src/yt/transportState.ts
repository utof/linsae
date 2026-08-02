import { create } from 'zustand'

/**
 * Playback-rate cycle, in order. Literal sequence mandated by
 * docs/plans/v0.8.2-composer-dataloss.md §3.2 ("do not re-invent") — it restores
 * the `RATES` array that lived in `ThreadView` before commit 4ab51f0 deleted it.
 *
 * NOT exported: nothing outside this module consumes it (B2 reads `cycleRate()`'s
 * return value instead), and an unused export fails the precommit knip gate —
 * same reasoning as pdf/excerptState.ts:4-5.
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
   * one-liner instead of re-reading the store after a `set`. Mirrors the
   * get()+set()-in-one-action precedent at pdf/pendingJumpState.ts:40-44.
   */
  cycleRate: () => number
  /**
   * Publish the thread's marker timestamps. No-ops when the values are unchanged,
   * so a republishing effect cannot churn subscribers' references.
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
 *   **"Player-scoped" names THIS STORE's lifetime, not the player's — B2 must close
 *   the gap.** The player does not hold the rate: `load(id)` reassigns the webview's
 *   `src` (`playerSingleton.ts:299-307`), a full guest reload, and the guest's
 *   `setRate` handler writes `videoEl.playbackRate` (`yt/inject/youtube-guest.ts:203`)
 *   on the `<video>` that reload destroys. `Player` exposes no `getPlaybackRate()` to
 *   read the truth back, so this store is the SOLE holder of `rate` and never pushes
 *   it. Without a re-push on video change — `useEffect(() => player.setPlaybackRate(rate),
 *   [videoId, rate])` — the badge silently reads 1.75× while playback runs at 1×.
 * - `markers` are THREAD-scoped. `ThreadView` is the sole publisher and owns the
 *   lifecycle: republish on change, and call `clearMarkers()` from the effect's
 *   cleanup so one thread's ticks can never appear on the next video's scrubber.
 *   Keeping this a publisher obligation avoids keying the store by `videoId`, which
 *   the plan's "small store" (§3.2) does not call for.
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
    // Nothing can reach that state today — `rate` is written only here and by
    // setState, and there is no getPlaybackRate() to import a foreign value. This is
    // free insurance for the `setRate` the store TSDoc's re-push caveat anticipates,
    // not a live threat: suppressing the resync would cost MORE code than allowing it.
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
