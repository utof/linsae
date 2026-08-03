// @vitest-environment happy-dom
import { render } from '@testing-library/react'
import { useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushMicrotasks } from '../../../../tests/flush'
import {
  awaitPublished,
  connectGuest,
  destroyGuests,
  installWebviewStub,
  type StubbedWebview,
} from '../../../../tests/yt-fake-guest'

// ISOLATION: `isolate: false` (`vitest.config.ts`) shares one happy-dom context per worker, and
// both `PlayerPane.test.tsx` and `usePlayer.test.tsx` `vi.mock('./playerSingleton')` — while
// this file's whole premise (spec §8.2 T12) is that it drives the REAL singleton. Clearing the
// module cache in `vi.hoisted` (it runs before imports, even before `vi.mock`) is the same guard
// both of those files carry, for the mirror-image reason. (ADR 0014)
//
// It CANNOT fire today, and is kept anyway: measured at vitest 4.1.7, running
// `PlayerPane.test.tsx` and this file in one worker (`--fileParallelism=false`, PlayerPane
// first) is green without it, so a mock registered by an earlier FILE does not reach this one.
// The guard costs nothing and is what keeps that true independently of the sequencer's file
// order — which is by descending file size, not the alphabetical order the sibling comments
// assume.
vi.hoisted(() => vi.resetModules())

/**
 * The `<webview>` stub, the `createElement` spy that installs it, and the handshake helpers all
 * come from the shared harness — this file drives the same real singleton `playerSingleton.test.ts`
 * does, and a second copy of that fixture is how the two drift apart.
 */
let restoreWebviewStub = (): void => {}
beforeEach(() => {
  restoreWebviewStub = installWebviewStub()
})

import { destroyPlayer, getPlayer } from './playerSingleton'
import { usePlayer } from './usePlayer'
import { usePlayerState } from './usePlayerState'

afterEach(() => {
  destroyGuests()
  destroyPlayer()
  restoreWebviewStub()
  vi.restoreAllMocks()
})

const VIDEO_A = 'M7lc1UVf-VE'
const VIDEO_B = 'dQw4w9WgXcQ'

/**
 * A FULL `VideoFlags` payload. `{ duration: 213 }` alone leaves `currentTime` undefined, which
 * `applyState` writes straight into the cache — the next read would then be a lie (spec §8.1).
 */
const SEEDED = {
  ready: true,
  ended: false,
  paused: true,
  waiting: false,
  started: true,
  currentTime: 0,
  duration: 213,
}

/**
 * Both hooks poll on a rAF loop throttled to 200ms (`ts - last > 200`), so every duration
 * assertion here is waiting on real wall clock, not on a microtask. Measured end-to-end at
 * ~250ms per transition; the 4s ceiling is headroom for full-suite CPU contention (#203), well
 * under `vi.waitFor`'s 1000ms default being enough on an idle machine.
 */
const POLL = { timeout: 4000, interval: 20 } as const

function webviewOf(p: ReturnType<typeof getPlayer>): StubbedWebview {
  return p.wrapper.querySelector('webview') as unknown as StubbedWebview
}

/**
 * One component holding BOTH hooks, recording every `duration` each of them returned.
 *
 * Recording the SEQUENCE rather than reading the latest value is what lets the negative
 * assertion in T12 mean anything: "never took video A's duration" is a claim about the whole
 * history, and the latest value alone cannot express it.
 *
 * Production splits the two hooks across sibling components — `PlayerPane` owns the sole
 * `usePlayer` (the single-mount invariant, ADR 0016) and `ThreadView` owns `usePlayerState`.
 * Putting them in one component gives their relative order a single editable site, which is
 * what spec §8.2's T12 row nominates as the falsifying mutation. See the note on that order
 * below for what swapping it actually does.
 */
function makeProbe(): {
  seen: { player: (number | null)[]; state: (number | null)[] }
  Probe: (props: { videoId: string }) => React.JSX.Element
} {
  const seen = { player: [] as (number | null)[], state: [] as (number | null)[] }
  function Probe({ videoId }: { videoId: string }): React.JSX.Element {
    const hostRef = useRef<HTMLDivElement>(null)
    // This order is spec §8.2's nominated mutation site for T12, and swapping it alone is
    // INERT — measured, three consecutive green runs. React flushes both effects in one commit,
    // and NEITHER hook reads `getDuration()` in its effect body: both defer the first read to a
    // rAF tick, so no frame can land between them whichever order they run in. §7's invariant
    // is "`usePlayer`'s effect runs before `usePlayerState`'s first rAF TICK", and the tick is
    // what makes the order immaterial rather than the order being the guarantee.
    //
    // It stops being inert the moment either hook reads during the effect phase: with a
    // `player.getDuration().then(setDuration)` added at the top of `usePlayerState`'s effect,
    // THIS order is green and the swap is red (`[null, 213, 213, 500, 500]`). T12's recorded
    // falsifying mutation is the one that fails it as written — dropping `resetCache()` from
    // `teardown()`, which yields `[null, 213, 500]`. Both are in this task's report.
    const fromPlayer = usePlayer(videoId, hostRef)
    const fromState = usePlayerState(videoId)
    seen.player.push(fromPlayer.duration)
    seen.state.push(fromState.duration)
    return <div ref={hostRef} />
  }
  return { seen, Probe }
}

/**
 * T8 and T12 (spec §8.2) — the #211 L2 half, driven through the hooks against the REAL
 * singleton.
 *
 * Deliberately no `vi.mock('./playerSingleton')`: `usePlayer.test.tsx` and `PlayerPane.test.tsx`
 * both mock it, which is precisely why neither can see any of this — a mocked `getDuration`
 * returns whatever the fixture says regardless of what `load()`/`teardown()` did to the cache.
 *
 * No `renderWithProviders` / `installMockApi` either: neither hook touches `window.api` or
 * react-query, so the bare RTL `render` is the honest harness.
 */
describe('usePlayer + usePlayerState duration (T8, T12)', () => {
  /**
   * T8 — the duration VALUE moves 213 → 500 while the hook stays mounted on one video.
   *
   * NOT "across a videoId change", which is how spec §8.2's T8 row reads. `durationDone` was
   * declared INSIDE the effect, so a videoId change re-runs the effect and re-initialises the
   * latch to `false` in a fresh closure — a test written that way passes with the latch
   * restored, i.e. it is vacuous (measured; recorded in this task's report). The latch is
   * observable only WITHIN one effect run, which is exactly the permanent-staleness failure
   * mode §7 L2 names as the reason to delete it rather than reset it.
   *
   * The second document is not a contrivance: §7 L1 lists the consent redirect and YouTube's
   * own self-reload as the paths that swap the guest document without going through `load()`,
   * and a pre-roll ad puts its OWN duration on the same `<video>` before the real one arrives.
   * Latched, the scrubber stays scaled to whichever of those spoke first, for the life of the
   * mount.
   */
  it('re-polls duration past the first non-null read (T8, #211 L2)', async () => {
    const p = getPlayer()
    const wv = webviewOf(p)
    const { seen, Probe } = makeProbe()
    render(<Probe videoId={VIDEO_A} />)

    const first = await connectGuest(wv)
    await awaitPublished(p, first)
    first.emitState(SEEDED)
    await vi.waitFor(() => {
      expect(seen.state.at(-1)).toBe(213)
      expect(seen.player.at(-1)).toBe(213)
    }, POLL)

    // A second document commits for the SAME videoId, so neither hook's effect re-runs and
    // neither closure is rebuilt. `dom-ready` → `teardown()` → `resetCache()` drops the 213.
    const second = await connectGuest(wv)
    await awaitPublished(p, second)
    second.emitState({ ...SEEDED, duration: 500 })

    await vi.waitFor(() => {
      expect(seen.state.at(-1)).toBe(500)
      expect(seen.player.at(-1)).toBe(500)
    }, POLL)
  })

  /**
   * T12 — the §7 ordering invariant: `usePlayer`'s effect (`player.load(B)` → `teardown()` →
   * cache reset) runs before `usePlayerState`'s first rAF tick reads `getDuration()`, because
   * both are `useEffect`s flushed in the same commit and no frame can land between them.
   *
   * Why it is load-bearing rather than incidental: `ThreadView`'s `durationWrittenRef` latches
   * the FIRST non-null duration it sees and never rewrites, then `api.videoSources.upsert`
   * puts it on B's `video_sources` row — on disk, surviving restart. One stale read is the
   * whole of #211.
   *
   * The remount is faithful, not a convenience: `App.tsx` keys `ThreadView` by `threadNoteId`
   * "so the player singleton and duration write-back state reset per video", so a video change
   * IS a fresh mount with `duration` back at null and a fresh `durationWrittenRef`.
   *
   * Measured, without the remount: the `videoId = 'B'` re-render seeds `seen` with A's still-
   * current 213 before any poll runs, so the assertion goes red against CORRECT code too
   * (`[213, 500]`), and red under the `resetCache` mutation as well (`[213, 500, 500]`). The
   * failure mode is not "cannot fail" — it is red both ways, i.e. zero discriminating power.
   */
  it('never lets the previous video’s duration reach the hook after a change (T12, §7)', async () => {
    const p = getPlayer()
    const wv = webviewOf(p)
    const { seen, Probe } = makeProbe()
    const Keyed = ({ videoId }: { videoId: string }) => <Probe key={videoId} videoId={videoId} />
    const view = render(<Keyed videoId={VIDEO_A} />)

    const a = await connectGuest(wv)
    await awaitPublished(p, a)
    a.emitState(SEEDED)
    await vi.waitFor(() => {
      expect(seen.state.at(-1)).toBe(213)
      expect(seen.player.at(-1)).toBe(213)
    }, POLL)

    // Everything from here on is measured against A's 213 having provably reached both hooks.
    seen.player.length = 0
    seen.state.length = 0
    view.rerender(<Keyed videoId={VIDEO_B} />)
    // Drains the commit turn plus anything it enqueued, so a stale read deferred by one
    // microtask has already landed in `seen` rather than arriving after the assertions.
    await flushMicrotasks()

    // B's own duration, over a window that therefore provably contains many poll ticks — the
    // positive half that stops the negative below from being an assertion into an empty window.
    const b = await connectGuest(wv)
    await awaitPublished(p, b)
    b.emitState({ ...SEEDED, duration: 500 })
    await vi.waitFor(() => {
      expect(seen.state.at(-1)).toBe(500)
      expect(seen.player.at(-1)).toBe(500)
    }, POLL)
    await flushMicrotasks()

    // The claim, over the whole recorded history rather than the latest value. `vi.waitFor`
    // cannot express it: it returns on its FIRST passing tick, so it can only prove "eventually
    // true", never "never happened" (`tests/flush.ts`). A 213 anywhere in here is a duration
    // read out of the cache AFTER the switch to B — #211's write-back, exactly.
    expect(seen.state).not.toContain(213)
    expect(seen.player).not.toContain(213)
  })
})
