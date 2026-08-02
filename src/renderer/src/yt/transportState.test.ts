// NOTE: deliberately NOT pinned to `// @vitest-environment node`, unlike the sibling
// store tests pdf/excerptState.test.ts:1 and pdf/pendingJumpState.test.ts:1.
// The `dom` vitest project runs with `isolate: false` (vitest.config.ts:35), so a
// node-pinned file forces a mid-run environment teardown/recreate. Adding one here
// made pdf/PdfPage.test.tsx fail 8 tests ("cancels the render task BEFORE
// page.cleanup() on unmount") while passing 11/11 in isolation. Measured on this
// branch: with the pin → 1 file / 8 tests failed; without it → 161 files, 1367 tests,
// all green. This store needs no DOM, so inheriting happy-dom costs nothing.
// The underlying fragility is PdfPage.test.tsx's order sensitivity, not this file.
import { beforeEach, describe, expect, it } from 'vitest'
import { useTransportStore } from './transportState'

/**
 * Snapshot of the store's OWN initial state, captured at module load before any
 * test mutates it. Restoring from this — rather than from a hand-written literal
 * like pendingJumpState.test.ts:18 uses — is what keeps the "initial state" test
 * below falsifiable: a literal would silently re-establish the defaults it claims
 * to assert, so flipping a default in the initializer would not fail anything.
 * (Verified by mutation: `followOn: true → false` survived the literal version.)
 */
const INITIAL = useTransportStore.getState()

/**
 * `setState(…, true)` REPLACES rather than merges, so the reset cannot leave a
 * mutated field behind. Safe because `INITIAL` carries the actions too. Reset via
 * zustand's own setState rather than the store's actions, so a broken action can't
 * mask the next test's starting state. Mandatory here: the `dom` vitest project
 * runs with `isolate: false` (vitest.config.ts:35), so module singletons are
 * shared across files in a worker.
 */
beforeEach(() => {
  useTransportStore.setState(INITIAL, true)
})

describe('transportState — initial state', () => {
  it('starts with follow ON, rate 1×, and no markers', () => {
    // followOn defaults true so B3's swap of ThreadView's `const followOn = true`
    // (:260) is behaviour-preserving.
    expect(INITIAL.followOn).toBe(true)
    expect(INITIAL.rate).toBe(1)
    expect(INITIAL.markers).toEqual([])
  })
})

describe('transportState — followOn', () => {
  it('toggleFollow flips the flag off and back on', () => {
    useTransportStore.getState().toggleFollow()
    expect(useTransportStore.getState().followOn).toBe(false)
    useTransportStore.getState().toggleFollow()
    expect(useTransportStore.getState().followOn).toBe(true)
  })
})

describe('transportState — rate', () => {
  it('cycleRate walks the full 1 → 1.25 → 1.5 → 1.75 → 2 sequence, then wraps to 1', () => {
    // Literal sequence from docs/plans/v0.8.2-composer-dataloss.md §3.2.
    const seen = [
      useTransportStore.getState().cycleRate(),
      useTransportStore.getState().cycleRate(),
      useTransportStore.getState().cycleRate(),
      useTransportStore.getState().cycleRate(),
      useTransportStore.getState().cycleRate(),
    ]
    expect(seen).toEqual([1.25, 1.5, 1.75, 2, 1])
  })

  it('cycleRate returns the SAME value it stored (B2 feeds the return to setPlaybackRate)', () => {
    const returned = useTransportStore.getState().cycleRate()
    expect(returned).toBe(useTransportStore.getState().rate)
    expect(returned).toBe(1.25)
  })

  it('cycleRate resyncs to 1× from a rate that is not in the sequence', () => {
    // indexOf → -1, so (-1 + 1) % len === 0. Guards against a stray rate (e.g. one
    // YouTube applied itself) permanently wedging the cycle.
    useTransportStore.setState({ rate: 1.4 })
    expect(useTransportStore.getState().cycleRate()).toBe(1)
  })
})

describe('transportState — markers', () => {
  it('setMarkers stores the published timestamps', () => {
    useTransportStore.getState().setMarkers([12, 40.5, 99])
    expect(useTransportStore.getState().markers).toEqual([12, 40.5, 99])
  })

  it('setMarkers with an equal-valued array keeps the SAME reference', () => {
    // Why: B3 republishes `markerPositions(sorted, duration).map(m => m.t)` from an
    // effect whose deps include the ~5 Hz-polled duration. Without this dedupe every
    // poll would hand PlayerPane a fresh array identity and re-render the transport.
    useTransportStore.getState().setMarkers([12, 40.5, 99])
    const first = useTransportStore.getState().markers
    useTransportStore.getState().setMarkers([12, 40.5, 99])
    expect(useTransportStore.getState().markers).toBe(first)
  })

  it('setMarkers replaces when the values differ', () => {
    useTransportStore.getState().setMarkers([12, 40.5, 99])
    useTransportStore.getState().setMarkers([12, 40.5, 100])
    expect(useTransportStore.getState().markers).toEqual([12, 40.5, 100])
  })

  it('setMarkers replaces when the length differs but the prefix matches', () => {
    // Guards a length-blind element-wise comparison.
    useTransportStore.getState().setMarkers([12, 40.5])
    useTransportStore.getState().setMarkers([12, 40.5, 99])
    expect(useTransportStore.getState().markers).toEqual([12, 40.5, 99])
    useTransportStore.getState().setMarkers([12, 40.5])
    expect(useTransportStore.getState().markers).toEqual([12, 40.5])
  })

  it('clearMarkers empties the list and is reference-stable when repeated', () => {
    useTransportStore.getState().setMarkers([12, 40.5, 99])
    useTransportStore.getState().clearMarkers()
    expect(useTransportStore.getState().markers).toEqual([])
    const empty = useTransportStore.getState().markers
    useTransportStore.getState().clearMarkers()
    expect(useTransportStore.getState().markers).toBe(empty)
  })
})

describe('transportState — lifetimes', () => {
  it('clearMarkers leaves followOn and rate untouched', () => {
    // The lifetime split B2/B3 depend on: markers are THREAD-scoped (ThreadView is
    // the sole publisher and clears them on unmount), while followOn and rate are
    // PLAYER-scoped preferences that must survive ThreadView unmounting while the
    // docked player keeps playing — the entire point of the v0.6.4 B5 lift.
    useTransportStore.getState().toggleFollow()
    useTransportStore.getState().cycleRate()
    useTransportStore.getState().setMarkers([7])
    useTransportStore.getState().clearMarkers()

    const s = useTransportStore.getState()
    expect(s.markers).toEqual([])
    expect(s.followOn).toBe(false)
    expect(s.rate).toBe(1.25)
  })

  it('has no global reset action — there is deliberately nothing that clears rate/followOn', () => {
    // Falsifiable guard on the decision above: if a later task adds `reset()`, this
    // test fails and forces a re-read of the lifetime rationale rather than a silent
    // regression of the B5 persistence guarantee.
    //
    // Deliberately NOT an exact-key-set assertion. That form also goes red when a
    // later task adds an UNRELATED member — e.g. the `setRate` the rate-desync
    // caveat in transportState.ts anticipates — and reports it as a lifetime
    // violation that never happened. Guard the rule, not the shape.
    expect(useTransportStore.getState()).not.toHaveProperty('reset')
  })
})
