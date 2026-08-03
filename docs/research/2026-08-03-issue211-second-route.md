# The second route to #211: the value cache is read before `load()` can reset it

**Date:** 2026-08-03 · **Milestone:** v0.8.3 (`player-transport`) · **Status:** measured, unfixed

## Question

v0.8.3 closes #211's named mechanism — `load()` now calls `teardown()`, which calls `resetCache()`.
Spec §9 acceptance criterion 3 states the user-visible consequence: *"Opening video B after video A
leaves B's own `durationSec` in `video_sources`."*

During Task 9 a second route to the same on-disk corruption was traced through source. It does not
go through `load()` at all, so nothing this milestone built can see it. This document records the
measurement that settled whether it is real.

## Verdict

**It reproduces.** 20/20 race configurations, across four mocked-IPC latencies and four frame
cadences, stable across 3 consecutive full-matrix runs. The negative control returns the correct
value in the same harness, so the positive result is a measurement rather than a property of the
fixture.

**Spec §9 AC3 is therefore not met in production**, and #211's acceptance criterion — which is
worded as the user-visible outcome, not as the `load()`-path mechanism — is not satisfied by this
milestone alone.

## The race

Both sides start when `notes.get(B)` resolves and `ThreadView`'s `videoId` stops being `''`.

**Fast side** — `ThreadView` (keyed remount, `App.tsx`) calls `usePlayerState(videoId)`, whose rAF
loop starts with `last = 0`, so the first frame clears the 200 ms throttle and calls
`player.getDuration()`. That is a plain read of module-level `cache.duration` in `playerSingleton.ts`
— no guest round-trip — and it still holds A's number. `ThreadView`'s write-back effect has a fresh
`durationWrittenRef` (the keyed remount reset it), so it latches that first non-null value and calls
`api.videoSources.upsert(B, { durationSec: … })`.

**Slow side** — the only thing that clears the cache is `load(B)` → `teardown()` → `resetCache()`.
`load()` is reachable only from `usePlayer`, which runs only inside `PlayerPaneInner`, which mounts
only once `useSetting('player.videoId')` returns non-null. `ThreadView` writes that setting through
`useSetSetting`, and **`useSetSetting` has no `onMutate`** (`lib/use-setting.ts`) — it invalidates
only `onSuccess`. So B reaches `PlayerPane` after a `settings.set` IPC round-trip, an invalidation, a
`settings.get` refetch, and two more React commits.

The fast side needs one frame. The slow side needs two IPC round-trips plus two commits.

### It is structural, not incidental

The rAF loop starts at `ThreadView(B)`'s **first** commit, while `videoId` is still `''`. In 9 of 12
sweep rows the first poll read landed *before* `notes.get(B)` resolved. The fast side does not have
to win a race — the frame it needs is already in flight before the slow chain starts.

## Results

`margin` = ms(`load(B)`) − ms(`upsert(B, …)`). Positive means the stale write reached disk before the
cache was reset.

| config | outcome | ms→upsert(B) | ms→load(B) | margin |
|---|---|---|---|---|
| native rAF, ipc=0ms | STALE_A_ON_B | 43.0 | 60.4 | +17.4 |
| native rAF, ipc=1ms | STALE_A_ON_B | 30.3 | 46.4 | +16.1 |
| native rAF, ipc=5ms | STALE_A_ON_B | 49.0 | 72.2 | +23.1 |
| native rAF, ipc=10ms | STALE_A_ON_B | 50.3 | 79.6 | +29.3 |
| native rAF, settings-only delay, ipc=0/1/5/10ms | STALE_A_ON_B ×4 | 27.1–33.3 | 42.0–59.9 | +11.9…+26.6 |
| frame=4ms, ipc=0/1/5/10ms | STALE_A_ON_B ×4 | 21.6–39.7 | 32.1–62.9 | +10.6…+29.1 |
| frame=8ms, ipc=0/1/5/10ms | STALE_A_ON_B ×4 | 24.0–38.7 | 36.4–67.1 | +10.1…+28.4 |
| frame=16.7ms, ipc=0/1/5/10ms | STALE_A_ON_B ×4 | 22.0–37.4 | 33.6–67.7 | +11.6…+30.3 |
| **CONTROL** (`load(B)` completed first), ipc=0ms | CORRECT_B_ON_B | 27.2 | n/a | — |
| **CONTROL**, ipc=5ms | CORRECT_B_ON_B | 31.7 | n/a | — |

In every race row there is **exactly one** upsert for B, carrying A's value. B's own duration arrives
later and is discarded by `durationWrittenRef`, so B's `video_sources.durationSec` permanently holds
A's number.

### Measured timeline — frame=16.7 ms, ipc=0 ms, the row most favourable to `load(B)`

```
18.54ms  notes.get(B) resolved          → ThreadView's videoId flips '' → B
18.73ms  first rAF poll read -> 213     ← A's duration, straight out of cache.duration
34.20ms  upsert(B, 213)                 ← the bug, on disk
47.23ms  load(B) -> teardown/resetCache ← 13ms too late
```

## Why the frame cadence had to be controlled

happy-dom implements `requestAnimationFrame` as `TIMER.setImmediate` (happy-dom 20.9.0,
`BrowserWindow.js`), measured at **0.031–0.31 ms** between frames — 50–500× faster than a compositor.
That artifact favours the fast side, i.e. it biases *toward* the hypothesis. Relying on it alone
would have been worthless.

So the probe installs a shim replacing `requestAnimationFrame`/`cancelAnimationFrame` with a batched
fixed-cadence scheduler, and sweeps 4 / 8 / 16.7 ms against IPC 0 / 1 / 5 / 10 ms. All 12 rows still
reproduce. The shim is additionally phase-pessimistic for the fast side: a real frame arrives
uniformly in [0, 16.7 ms) after a commit, whereas the shim always waits the full `frameMs`.

Note that `framesBeforeLoadB` under native rAF is not a usable number — `setImmediate` spins
arbitrarily fast whenever a timer is pending, so it swings between 6 and 9072. Only the shim rows
(4–24 frames) mean anything.

## Confidence, and what would settle it completely

**High, not certain.** The harshest cell (16.7 ms frame, 0 ms IPC) still left a +11.6 ms margin, and
0 ms IPC is strictly better than production can achieve. For `load(B)` to win in production you would
need two real `ipcRenderer.invoke` round-trips — one of them a better-sqlite3 *write* — plus two React
commits, all inside a single frame.

Working the other way: happy-dom inflates React commit cost, and the slow side pays it twice more
than the fast side, so production margins are probably smaller than measured.

The natural confirmation is a real-Electron check. **`scripts/thread-smoke.mjs` does not cover it** —
`SMOKE_FORCE_SWAP=1` forces two documents within *one* video (the #213 transport gate), never an
A→B thread switch.

## Trace, link by link

All nine links verified against source by two independent readers:

1. `App.tsx` — `<ThreadView key={threadNoteId} …>`; keyed, so `durationWrittenRef` resets per open.
2. `ThreadView.tsx` — `usePlayerState(videoId)` with its own video id.
3. `usePlayerState.ts` — `last = 0`, `if (ts - last > 200)`, `getDuration().then(…)`. `ts` is
   `performance.now()` (thousands of ms), so the first frame always clears the throttle.
4. `playerSingleton.ts` — `async getDuration() { return cache.duration }`. Plain read.
5. `resetCache()` is called from `teardown()`, reached from `load()`, `dom-ready`,
   `did-start-navigation`, and `destroyPlayer()` (HMR/test-only, not on this path).
6. `ThreadView.tsx` — the write-back effect, deps `[videoId, duration]`.
7. `usePlayer.ts` holds the only non-test `player.load(` call site.
8. `use-setting.ts` / `ThreadView.tsx` — the setting write.
9. `use-setting.ts` — `useMutation` with `onSuccess` invalidate only, **no `onMutate`**.

## Limits of the fixture

1. IPC latency is `setTimeout(L)` in-renderer, not a process hop plus a real SQLite write. This
   understates the slow side — conservative in the bug's direction. At L=0 the slow side is as fast
   as it can possibly be and still loses.
2. `<webview>` is stubbed (`tests/yt-fake-guest.ts`). It does not shift this race: `teardown()` runs
   synchronously inside `load()` *before* the `webviewEl.src` assignment, so the reset's timing does
   not depend on the stubbed navigation.
3. `App` is not mounted; the probe uses a two-component tree (`ThreadView` + `PlayerPane` under one
   `QueryClientProvider`). Lost: App's other concurrent queries competing for the event loop, the
   `motion`/`AnimatePresence` stage wrappers, `handlePaneClose`, and the real user gesture
   (feed click → `setThreadNoteId`). None sit on either side of this race.
4. React render cost in happy-dom is inflated; both sides pay it, the slow side twice more.

## The probe

Preserved verbatim below because it is the regression test for whoever fixes this — it already has a
working negative control. It lives outside `src/renderer/**`, which is the scope of `vitest.config.ts`'s
`dom` project, so it is never collected by `pnpm test`; it was run with its own config via
`npx vitest run --config <cfg> --disable-console-intercept`.

```tsx
/**
 * MEASUREMENT PROBE — not a repo test. Question: does the "cache-read-before-load" route to
 * #211 (A's duration persisted onto B's video_sources row) reproduce through the REAL App
 * wiring — ThreadView + PlayerPane as siblings, real use-setting, real playerSingleton?
 *
 * The race under measurement:
 *   FAST side  — ThreadView(B) mounts (keyed remount) → usePlayerState's rAF loop reads
 *                player.getDuration(), which is a plain read of `cache.duration`
 *                (playerSingleton.ts:798-800), still holding A's number.
 *   SLOW side  — ThreadView(B) writes 'player.videoId'=B via useSetSetting (no optimistic
 *                onMutate; use-setting.ts:20-26) → settings.set IPC → invalidate → settings.get
 *                IPC refetch → PlayerPane re-render → usePlayer effect → load(B) → teardown()
 *                → resetCache() (playerSingleton.ts:223-225, :769).
 *
 * Mocked IPC latency is parameterized because a 0ms (microtask) mock hands the SLOW side a
 * win it cannot have in production.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushMicrotasks } from '@tests/flush'
import { installMockApi, type MockApi } from '@tests/setup'
import {
  awaitPublished,
  connectGuest,
  destroyGuests,
  installWebviewStub,
  type StubbedWebview,
} from '@tests/yt-fake-guest'
import type { Note } from '@shared/types'

// Same guard as usePlayerState.test.tsx: this file drives the REAL singleton, and sibling
// files in the repo vi.mock('./playerSingleton').
vi.hoisted(() => vi.resetModules())

let restoreWebviewStub = (): void => {}
beforeEach(() => {
  restoreWebviewStub = installWebviewStub()
})

import { ThreadView } from '@renderer/thread/ThreadView'
import { useDockStore } from '@renderer/panes/dockStore'
import { PlayerPane } from '@renderer/yt/PlayerPane'
import { destroyPlayer, getPlayer } from '@renderer/yt/playerSingleton'
import { useTransportStore } from '@renderer/yt/transportState'

const DOCK_INITIAL = useDockStore.getState()
const TRANSPORT_INITIAL = useTransportStore.getState()

// happy-dom has no layout engine and RTL nodes call scrollIntoView from the Rail.
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = vi.fn()
}

afterEach(() => {
  destroyGuests()
  destroyPlayer()
  restoreWebviewStub()
  vi.restoreAllMocks()
  useDockStore.setState(DOCK_INITIAL, true)
  useTransportStore.setState(TRANSPORT_INITIAL, true)
})

const VIDEO_A = 'M7lc1UVf-VE'
const VIDEO_B = 'dQw4w9WgXcQ'
const DUR_A = 213
const DUR_B = 500

const NOTE_A: Note = {
  id: 'note-A',
  slug: 'video-a',
  body: '',
  type: 'source',
  created_at: 1000,
  updated_at: 1000,
  deleted_at: null,
  source_kind: 'youtube',
  source_locator: { media: 'youtube', video_id: VIDEO_A },
}
const NOTE_B: Note = { ...NOTE_A, id: 'note-B', slug: 'video-b', source_locator: { media: 'youtube', video_id: VIDEO_B } }

/** FULL VideoFlags payload — a partial one seeds `undefined` into the cache (harness §8.1). */
const flags = (duration: number) => ({
  ready: true,
  ended: false,
  paused: true,
  waiting: false,
  started: true,
  currentTime: 0,
  duration,
})

function webviewOf(p: ReturnType<typeof getPlayer>): StubbedWebview {
  return p.wrapper.querySelector('webview') as unknown as StubbedWebview
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Replace happy-dom's `requestAnimationFrame` with a fixed-cadence shim.
 *
 * Why this exists: happy-dom implements rAF as `TIMER.setImmediate` (BrowserWindow.js:2104),
 * MEASURED here at 0.03–0.31 ms between frames. A real compositor fires at ~16.7 ms. Since the
 * whole question is "one frame vs N IPC round-trips", a 500×-fast frame hands the FAST side of
 * the race an advantage it does not have in production — so the native cadence alone cannot
 * answer whether the window is real. This shim batches all callbacks registered before a frame
 * and runs them together on one timer, the way a compositor does.
 */
function installRafShim(frameMs: number): () => void {
  const origReq = globalThis.requestAnimationFrame
  const origCancel = globalThis.cancelAnimationFrame
  let queue = new Map<number, FrameRequestCallback>()
  let nextId = 1
  let timer: ReturnType<typeof setTimeout> | null = null
  const schedule = (): void => {
    if (timer) return
    timer = setTimeout(() => {
      timer = null
      const batch = queue
      queue = new Map()
      const ts = performance.now()
      for (const cb of batch.values()) cb(ts)
      if (queue.size) schedule()
    }, frameMs)
  }
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    const id = nextId++
    queue.set(id, cb)
    schedule()
    return id
  }) as typeof globalThis.requestAnimationFrame
  globalThis.cancelAnimationFrame = ((id: number) => {
    queue.delete(id)
  }) as typeof globalThis.cancelAnimationFrame
  return () => {
    if (timer) clearTimeout(timer)
    globalThis.requestAnimationFrame = origReq
    globalThis.cancelAnimationFrame = origCancel
  }
}

// ── frame counter ───────────────────────────────────────────────────────────
// An independent rAF chain on the same queue usePlayerState's poll uses, so "frames before
// load(B)" is measured in the same units the race is run in.
let frames = 0
let frameRaf = 0
function startFrames(): void {
  frames = 0
  const tick = (): void => {
    frames++
    frameRaf = requestAnimationFrame(tick)
  }
  frameRaf = requestAnimationFrame(tick)
}
function stopFrames(): void {
  if (frameRaf) cancelAnimationFrame(frameRaf)
  frameRaf = 0
}

type Row = {
  latencyMs: number
  /** true = every mocked IPC call pays the latency; false = only settings.get/set do. */
  allIpcDelayed: boolean
  /** CONTROL: drive load(B) to completion BEFORE the keyed remount, so the cache is clean. */
  preloadB: boolean
  /** null = happy-dom's native setImmediate-backed rAF; a number = compositor-cadence shim. */
  frameMs: number | null
  outcome: 'STALE_A_ON_B' | 'CORRECT_B_ON_B' | 'NO_UPSERT_FOR_B'
  framesBeforeLoadB: number | null
  framesAtFirstBUpsert: number | null
  msSwitchToLoadB: number | null
  msSwitchToFirstBUpsert: number | null
  /** Ordered timeline of the race, ms from the keyed remount. */
  marks: Array<{ what: string; ms: number }>
  /** Poll reads of `cache.duration` after the switch — the FAST side of the race, itemised. */
  durationReads: Array<{ value: number | null; frame: number; ms: number }>
  upserts: Array<{ videoId: string; durationSec: unknown; frame: number; ms: number }>
  loads: Array<{ id: string; frame: number; ms: number }>
}

async function runScenario(
  latencyMs: number,
  allIpcDelayed: boolean,
  preloadB = false,
  frameMs: number | null = null,
): Promise<Row> {
  const restoreRaf = frameMs == null ? () => {} : installRafShim(frameMs)
  try {
    return await runScenarioInner(latencyMs, allIpcDelayed, preloadB, frameMs)
  } finally {
    restoreRaf()
  }
}

async function runScenarioInner(
  latencyMs: number,
  allIpcDelayed: boolean,
  preloadB: boolean,
  frameMs: number | null,
): Promise<Row> {
  const settingsStore: Record<string, unknown> = {}
  const upserts: Row['upserts'] = []
  const loads: Row['loads'] = []
  const durationReads: Row['durationReads'] = []
  let t0 = 0
  let tracing = false
  const marks: Array<{ what: string; ms: number }> = []
  const since = () => +(performance.now() - t0).toFixed(2)

  const lat = () => (latencyMs > 0 ? sleep(latencyMs) : Promise.resolve())
  const otherLat = () => (allIpcDelayed ? lat() : Promise.resolve())

  // NOTE: every window.api method takes ONE object payload — the renderer facade
  // (src/renderer/src/lib/api.ts:447/453/427/441) does the positional→object repackaging.
  const base = installMockApi()
  installMockApi({
    settings: {
      get: vi.fn(async ({ key }: { key: string }) => {
        await lat()
        return { value: settingsStore[key] ?? null }
      }),
      getMany: vi.fn(async () => ({ values: {} })),
      set: vi.fn(async ({ key, value }: { key: string; value: unknown }) => {
        await lat()
        settingsStore[key] = value
        return { ok: true as const }
      }),
    },
    notes: {
      ...base.notes,
      get: vi.fn(async ({ id }: { id: string }) => {
        await otherLat()
        // When B's note resolves is when ThreadView's `videoId` stops being '' — the gate on
        // BOTH sides of the race. Recorded to show which side was already armed by then.
        if (tracing && id === 'note-B') marks.push({ what: 'notes.get(B) resolved', ms: since() })
        return id === 'note-A' ? NOTE_A : id === 'note-B' ? NOTE_B : null
      }),
    },
    videoSources: {
      get: vi.fn(async () => {
        await otherLat()
        return null
      }),
      upsert: vi.fn(async (input: { videoId: string; durationSec?: number }) => {
        upserts.push({
          videoId: input.videoId,
          durationSec: input.durationSec,
          frame: frames,
          ms: since(),
        })
        if (tracing) marks.push({ what: `upsert(${input.videoId === VIDEO_B ? 'B' : 'A'}, ${input.durationSec})`, ms: since() })
        await otherLat()
      }),
    },
  })

  const p = getPlayer()
  const wv = webviewOf(p)
  const realLoad = p.load.bind(p)
  vi.spyOn(p, 'load').mockImplementation(async (id: string) => {
    loads.push({ id, frame: frames, ms: since() })
    if (tracing) marks.push({ what: `load(${id === VIDEO_B ? 'B' : 'A'}) -> teardown/resetCache`, ms: since() })
    return realLoad(id)
  })
  // Pass-through trace of the FAST side: `getDuration()` is a plain read of `cache.duration`
  // (playerSingleton.ts:798-800). Recording its RETURN is the direct evidence for trace links
  // 3-5 — the value the hook received, and when.
  const realGetDuration = p.getDuration.bind(p)
  vi.spyOn(p, 'getDuration').mockImplementation(async () => {
    const v = await realGetDuration()
    if (tracing && durationReads.length < 40) {
      durationReads.push({ value: v, frame: frames, ms: since() })
      if (durationReads.length === 1) marks.push({ what: `first rAF poll read -> ${v}`, ms: since() })
    }
    return v
  })

  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  // ThreadView keyed by noteId — App.tsx:1336. PlayerPane is its SIBLING and is NOT keyed,
  // exactly as in App (it lives in the always-mounted right DockHost).
  const Harness = ({ noteId }: { noteId: string }) => (
    <QueryClientProvider client={qc}>
      <ThreadView key={noteId} noteId={noteId} onClose={() => {}} />
      <PlayerPane />
    </QueryClientProvider>
  )

  startFrames()
  const view = render(<Harness noteId="note-A" />)

  // ── phase 1: video A is loaded, its guest speaks, its duration lands on disk ──
  await vi.waitFor(() => expect(loads.some((l) => l.id === VIDEO_A)).toBe(true), {
    timeout: 8000,
    interval: 5,
  })
  const guestA = await connectGuest(wv)
  await awaitPublished(p, guestA)
  guestA.emitState(flags(DUR_A))
  await vi.waitFor(
    () => expect(upserts.some((u) => u.videoId === VIDEO_A && u.durationSec === DUR_A)).toBe(true),
    { timeout: 8000, interval: 5 },
  )

  // ── phase 2: the keyed remount onto video B ──────────────────────────────────
  upserts.length = 0
  loads.length = 0

  if (preloadB) {
    // NEGATIVE CONTROL. Skip the race entirely: put B in the setting and let PlayerPane
    // complete load(B) → teardown() → resetCache() → B's guest → cache.duration = 500,
    // all BEFORE ThreadView remounts. If the probe still reported STALE here it would be
    // measuring nothing.
    settingsStore['player.videoId'] = VIDEO_B
    await qc.invalidateQueries({ queryKey: ['setting', 'player.videoId'] })
    await vi.waitFor(() => expect(loads.some((l) => l.id === VIDEO_B)).toBe(true), {
      timeout: 8000,
      interval: 5,
    })
    const early = await connectGuest(wv)
    await awaitPublished(p, early)
    early.emitState(flags(DUR_B))
    await vi.waitFor(async () => expect(await p.getDuration()).toBe(DUR_B), {
      timeout: 8000,
      interval: 5,
    })
    loads.length = 0
  }

  startFrames()
  t0 = performance.now()
  tracing = true
  view.rerender(<Harness noteId="note-B" />)

  // Let the race run to completion: load(B) must have happened, and B's own guest must have
  // spoken, before we classify. Both halves get a generous window so "no upsert at all" is a
  // real finding rather than an early read.
  if (!preloadB) {
    await vi.waitFor(() => expect(loads.some((l) => l.id === VIDEO_B)).toBe(true), {
      timeout: 8000,
      interval: 5,
    })
    const guestB = await connectGuest(wv)
    await awaitPublished(p, guestB)
    guestB.emitState(flags(DUR_B))
  }
  // A full poll window (the rAF loop is throttled to 200ms) plus slack, so a correct write
  // has had every chance to land.
  await sleep(700)
  await flushMicrotasks()
  tracing = false
  stopFrames()

  const bUpserts = upserts.filter((u) => u.videoId === VIDEO_B)
  const staleB = bUpserts.find((u) => u.durationSec === DUR_A)
  const correctB = bUpserts.find((u) => u.durationSec === DUR_B)
  const loadB = loads.find((l) => l.id === VIDEO_B) ?? null

  return {
    latencyMs,
    allIpcDelayed,
    preloadB,
    frameMs,
    outcome: staleB ? 'STALE_A_ON_B' : correctB ? 'CORRECT_B_ON_B' : 'NO_UPSERT_FOR_B',
    framesBeforeLoadB: loadB ? loadB.frame : null,
    framesAtFirstBUpsert: bUpserts[0]?.frame ?? null,
    msSwitchToLoadB: loadB ? loadB.ms : null,
    msSwitchToFirstBUpsert: bUpserts[0]?.ms ?? null,
    marks: marks.sort((a, b) => a.ms - b.ms),
    durationReads,
    upserts,
    loads,
  }
}

describe('#211 route 2 — cache read beats load(B)', () => {
  for (const allIpc of [true, false]) {
    for (const latency of [0, 1, 5, 10]) {
      it(`latency=${latency}ms allIpcDelayed=${allIpc}`, async () => {
        const row = await runScenario(latency, allIpc)
        console.log(`PROBE_ROW ${JSON.stringify(row)}`)
        expect(row.outcome).toBeTruthy()
      })
    }
  }

  // The probe's own falsifiability check. If this row is not CORRECT_B_ON_B, every
  // STALE_A_ON_B above is uninterpretable.
  for (const latency of [0, 5]) {
    it(`CONTROL preloadB latency=${latency}ms`, async () => {
      const row = await runScenario(latency, true, true)
      console.log(`PROBE_ROW ${JSON.stringify(row)}`)
      expect(row.outcome).toBe('CORRECT_B_ON_B')
    })
  }

  // CROSSOVER SWEEP. The rows above run on happy-dom's native rAF (~0.03 ms/frame), which is
  // ~500× a compositor's 16.7 ms — the one place the harness could be manufacturing the win.
  // This grid pits a realistic frame cadence against a realistic IPC latency.
  for (const frame of [4, 8, 16.7]) {
    for (const latency of [0, 1, 5, 10]) {
      it(`SWEEP frame=${frame}ms latency=${latency}ms`, async () => {
        const row = await runScenario(latency, true, false, frame)
        console.log(`PROBE_ROW ${JSON.stringify(row)}`)
        expect(row.outcome).toBeTruthy()
      })
    }
  }
})
```

And the config it was run with:

```ts
import { defineConfig } from 'vitest/config'

const REPO = '/media/vboxuser/G-samsung1/0utoffiles/code/linsae'
const SCRATCH =
  '/tmp/claude-1000/-media-vboxuser-G-samsung1-0utoffiles-code-linsae/5df3ff22-bc00-4884-89bb-3eabdd94e14d/scratchpad'
const NM = `${REPO}/node_modules`

/**
 * Probe-only vitest config. The repo's own config restricts the `dom` project to
 * `src/renderer/**`, so a scratch file outside the repo is never collected by it.
 *
 * The exact-match aliases exist because Vite resolves bare specifiers relative to the
 * IMPORTER's directory: a test file living in /tmp walks /tmp/... upward and never reaches
 * the repo's node_modules. Only THIS file's own imports need them — every repo source file
 * pulled in transitively resolves normally from its own location. Regex `find`s (not bare
 * strings) so `react` does not also swallow `react-dom` / `react/jsx-runtime`.
 */
export default defineConfig({
  root: REPO,
  test: {
    globals: false,
    environment: 'happy-dom',
    setupFiles: [`${REPO}/tests/setup.tsx`],
    isolate: false,
    include: [`${SCRATCH}/*.probe.test.tsx`],
    testTimeout: 30_000,
  },
  resolve: {
    alias: [
      { find: '@renderer', replacement: `${REPO}/src/renderer/src` },
      { find: '@shared', replacement: `${REPO}/src/shared` },
      { find: '@tests', replacement: `${REPO}/tests` },
      { find: /^react$/, replacement: `${NM}/react` },
      { find: /^react\/jsx-runtime$/, replacement: `${NM}/react/jsx-runtime` },
      { find: /^react\/jsx-dev-runtime$/, replacement: `${NM}/react/jsx-dev-runtime` },
      { find: /^react-dom$/, replacement: `${NM}/react-dom` },
      { find: /^vitest$/, replacement: `${NM}/vitest` },
      { find: /^@testing-library\/react$/, replacement: `${NM}/@testing-library/react` },
      { find: /^@tanstack\/react-query$/, replacement: `${NM}/@tanstack/react-query` },
    ],
  },
})
```
