/**
 * Harness for driving the REAL `playerSingleton` under happy-dom. The filename names the
 * guest side, but every export serves that one job, from both ends of the transport: the HOST
 * side (`stubWebview`/`installWebviewStub`/`StubbedWebview` — a stubbed Electron `<webview>`
 * and the `document.createElement` spy that installs it) and the GUEST side (`fakeGuest` on
 * the far end of the transferred `MessagePort`, plus `dispatchWebviewEvent`/`domReadyTransfer`/
 * `connectGuest`/`awaitPublished`, which walk the handshake between the two).
 *
 * Nothing here mocks the code under test — both consumers import `playerSingleton.ts`
 * unmocked; this module only supplies the two Electron-only surfaces happy-dom has no answer
 * for. It lives in `tests/` rather than beside the singleton because two files now drive the
 * same singleton, and a second copy of the fixture is how the two drift apart.
 *
 * **Every consuming file must call `destroyGuests()` in `afterEach`** — see its docblock for
 * why nothing here can enforce that.
 *
 * @see docs/specs/v0.8.3-player-transport.md §8.1
 */

import { expect, type Mock, vi } from 'vitest'
import type { VideoFlags } from '../src/renderer/src/yt/player-state'
import { createRpc, type Rpc } from '../src/renderer/src/yt/rpc'

/**
 * Electron builds a webview's DOM events as plain `Event`s carrying extra own
 * properties (`isMainFrame`, `isInPlace`), which `lib.dom`'s `Event` does not
 * declare and `WebviewElement` (in `playerSingleton.ts`) does not type either.
 * @see https://github.com/electron/electron/blob/v42.5.0/lib/renderer/web-view/web-view-impl.ts#L117-L120
 */
type WebviewEventProps = { isMainFrame?: boolean; isInPlace?: boolean }
type WebviewEvent = Event & WebviewEventProps

/**
 * The webview lifecycle events `playerSingleton.ts` actually listens for. A union rather
 * than `string` because a mistyped name has no runtime signal here: the dispatch succeeds,
 * nothing is listening, and the test fails as a `vi.waitFor` timeout in whatever it was
 * waiting on — minutes of debugging that `tsc` can spend zero on. Add a member when the
 * singleton starts listening for one.
 */
type WebviewEventName = 'dom-ready' | 'did-start-navigation'

/**
 * Dispatch a webview lifecycle event (`dom-ready`, `did-start-navigation`, …) the way
 * Electron constructs it: a bare `Event` with the extra fields assigned as own
 * properties, NOT a `CustomEvent` with a `detail`.
 *
 * Why it matters: `playerSingleton.ts` reads `e.isMainFrame` / `e.isInPlace` straight
 * off the event object, so a `CustomEvent`-shaped fake would read `undefined` and every
 * navigation assertion would pass vacuously.
 *
 * @see docs/specs/v0.8.3-player-transport.md §8.1
 */
export function dispatchWebviewEvent(
  el: HTMLElement,
  name: WebviewEventName,
  props: WebviewEventProps = {},
): void {
  const ev: WebviewEvent = Object.assign(new Event(name), props)
  el.dispatchEvent(ev)
}

/** One recorded host→guest port transfer (the `contentWindow.postMessage` in `handshake()`). */
type PortTransfer = { msg: unknown; port: MessagePort }

/**
 * The parts of the `<webview>` stub a test reads back, for the
 * `as unknown as StubbedWebview` cast every consumer needs — `wrapper.querySelector('webview')`
 * is typed `Element`, and none of these members exist on it.
 */
export type StubbedWebview = HTMLElement & {
  executeJavaScript: ReturnType<typeof vi.fn>
  transfers: PortTransfer[]
}

function stubWebview(el: HTMLElement): void {
  const ex = vi.fn(async (_code: string, _gesture?: boolean) => undefined)
  // Every host→guest port transfer, in order. A test reads the handshake token back
  // out of `msg` and hands `port` to `fakeGuest`.
  const transfers: PortTransfer[] = []
  Object.assign(el, {
    executeJavaScript: ex,
    insertCSS: vi.fn(async () => 'key'),
    setUserAgent: vi.fn(),
    // happy-dom gives an unknown element no `contentWindow`, so without this the port
    // transfer in `handshake()` throws into its own catch and every handshake assertion
    // downstream is vacuous.
    contentWindow: {
      postMessage: vi.fn((msg: unknown, _origin: string, transfer: Transferable[] = []) => {
        transfers.push({ msg, port: transfer[0] as MessagePort })
      }),
    },
    // Read by the C6 diagnostic in `onHandshakeFailed()` (spec §5.1): it names the guest's
    // current URL, and an unstubbed `getURL` would throw out of the handshake instead of
    // letting the test assert.
    getURL: vi.fn(() => 'https://www.youtube.com/watch?v=M7lc1UVf-VE'),
    transfers,
  })
  el.getBoundingClientRect = () =>
    ({
      x: 1,
      y: 2,
      width: 320,
      height: 180,
      top: 2,
      left: 1,
      right: 321,
      bottom: 182,
      toJSON() {},
    }) as DOMRect
}

/**
 * Make every `document.createElement('webview')` hand back a stubbed Electron `<webview>`.
 *
 * Why it is a `createElement` spy and not a fixture the test builds: `getPlayer()` creates the
 * element itself (`playerSingleton.ts`), so a test has no seam to inject one through. It must
 * therefore be installed BEFORE the first `getPlayer()` of the test — i.e. in `beforeEach`.
 *
 * Without it, `playerSingleton.ts`'s guest injection and its port transfer BOTH throw into
 * their own catches, no port is ever transferred, and `fakeGuest` has nothing to attach to —
 * so every handshake assertion passes against an implementation that did nothing.
 *
 * Returns a restore fn; call it in `afterEach`. Same contract as `tests/pdf-layout.ts`'s
 * `installPdfLayout`, and for the same reason: the renderer project sets `isolate: false`
 * (`vitest.config.ts`), so one happy-dom context is shared by every file in a worker and an
 * unrestored `document.createElement` spy leaks into unrelated later files.
 *
 * @see docs/specs/v0.8.3-player-transport.md §8.1
 * @issue utof/linsae#203
 */
export function installWebviewStub(): () => void {
  const orig = document.createElement.bind(document)
  const spy = vi.spyOn(document, 'createElement').mockImplementation(((
    tag: string,
    opts?: ElementCreationOptions,
  ) => {
    const el = orig(tag, opts)
    if (tag === 'webview') stubWebview(el)
    return el
  }) as typeof document.createElement)
  return () => {
    spy.mockRestore()
  }
}

/**
 * A stand-in for the injected YouTube guest, sitting on the far end of the
 * `MessageChannel` the host transfers into the webview.
 *
 * Built on the REAL `createRpc` rather than a raw `port.onmessage` capture, for two
 * reasons: `createRpc` assigns `port.onmessage` itself (`rpc.ts`), so the two cannot
 * coexist; and a guest that records an `invoke` but never replies leaves the host's
 * 1000ms timer — the `setTimeout` in `createRpc`'s `invoke` — to reject unhandled, which
 * under `isolate: false` (`vitest.config.ts`) surfaces in some *other* file's report.
 *
 * `MessageChannel` here is NODE's global (happy-dom's `Window` has none) — the same
 * thing `rpc.test.ts:7-13` already relies on. Its `MessagePort` has `start`/`onmessage`/
 * `close`, which is all `createRpc` touches.
 *
 * `opts.ack` picks the handshake reply:
 *   - `{ ack: token }` — echo that token, the shape a test uses after reading the token
 *     out of the host's recorded `postMessage`.
 *   - `{}` — post `token: undefined`, which by construction matches no real token. That
 *     is the deliberate default: a guest that answers on the wire but never satisfies
 *     the handshake.
 *   - `{ ack: false }` — post nothing, for tests that ack by hand later.
 *
 * **Prefer `openGuest`**, which is this function plus enrolment in `destroyGuests()`. Reach for
 * `fakeGuest` directly only when the guest must outlive the current file's `afterEach` — and
 * then teardown is yours: `guest.rpc.destroy()`, in a `finally` or its own hook, never as the
 * test's last statement (that line is skipped exactly when an assertion throws).
 *
 * @see docs/specs/v0.8.3-player-transport.md §8.1
 * @issue utof/linsae#213
 */
export function fakeGuest(
  port: MessagePort,
  opts: { ack?: string | false } = {},
): {
  rpc: Rpc
  pause: Mock
  seekTo: Mock
  setRate: Mock
  emitState: (f: VideoFlags & { currentTime: number; duration: number }) => void
  emitReady: () => void
} {
  const rpc = createRpc(port)
  // `() => null` rather than a bare `vi.fn()`: this guest's own `createRpc` awaits the
  // handler and posts the return as the `res` value (the `invoke` arm of its `onmessage`)
  // for the host to await, so an explicit null keeps the round-trip readable in a diff.
  const pause = vi.fn(() => null)
  const seekTo = vi.fn(() => null)
  const setRate = vi.fn(() => null)
  rpc.handle('pause', pause)
  rpc.handle('seekTo', seekTo)
  rpc.handle('setRate', setRate)
  // Posting on the port is not exclusive to `createRpc`, so this raw ack coexists with
  // it. `{ t: 'ack', token }` is a `Wire` member, handled by the `m.t === 'ack'` arm of
  // `createRpc`'s `onmessage`, so the host's `whenAck(token)` resolves off this post.
  if (opts.ack !== false) port.postMessage({ t: 'ack', token: opts.ack })
  return {
    rpc,
    pause,
    seekTo,
    setRate,
    // A FULL payload, deliberately: `applyState` in `playerSingleton.ts` writes
    // `f.currentTime` into the cache unconditionally, so a partial `{duration}` seeds
    // `undefined` there and the next cache assertion reads a lie.
    emitState: (f) => {
      rpc.send('state', f)
    },
    emitReady: () => {
      rpc.signalReady()
    },
  }
}

/** Guests opened through `openGuest`, awaiting `destroyGuests()`. */
const guests: ReturnType<typeof fakeGuest>[] = []

/**
 * `fakeGuest`, enrolled in this module's teardown list. **Your file still has to drain that
 * list: `afterEach(destroyGuests)`.** Nothing is registered with vitest here — see
 * `destroyGuests`.
 *
 * Why enrol rather than `guest.rpc.destroy()` as the test's own last statement: that line is
 * skipped exactly when an assertion throws, so a failing test leaves an open `MessagePort`
 * behind. Under `isolate: false` (`vitest.config.ts`) unrestored state "leaks into unrelated
 * later files and fails them in confusing places" — the lesson `tests/pdf-layout.ts` records.
 *
 * @issue utof/linsae#203
 */
export function openGuest(...args: Parameters<typeof fakeGuest>): ReturnType<typeof fakeGuest> {
  const g = fakeGuest(...args)
  guests.push(g)
  return g
}

/**
 * Destroy every guest opened since the last call. **`afterEach(destroyGuests)`, in every file
 * that opens one** — this module's whole cross-file safety contract is this one call.
 *
 * Why it cannot be enforced here: registering a hook at import time would bind it to whichever
 * file imported first, and `openGuest` has no vitest context to hook from, so the drain has to
 * be the caller's. Forgetting it fails NOTHING locally — measured 2026-08-03: with the call
 * commented out of `usePlayerState.test.tsx`, `vitest run src/renderer/src/yt/` is 9 files / 72
 * tests green. What leaks is an open `MessagePort` per guest plus `createRpc`'s pending 1000ms
 * `invoke` timers, and the renderer project sets `isolate: false` (`vitest.config.ts`), so one
 * happy-dom context is shared by every file in a worker: the cost lands as a #203-shaped flake
 * in some unrelated later file, never as a failure of the test that caused it. Same contract,
 * and same reasoning, as `installWebviewStub`'s restore fn and `tests/pdf-layout.ts`.
 *
 * @issue utof/linsae#203
 */
export function destroyGuests(): void {
  guests.splice(0).forEach((g) => {
    g.rpc.destroy()
  })
}

/**
 * Dispatch `dom-ready` and resolve the ONE port transfer it produces — `{ msg: token, port }`,
 * the raw material every handshake test works from.
 *
 * Indexed from a watermark rather than from 0 because the token is per-attempt (spec §5.5): a
 * test that drives a second document must read the second transfer's token, not the first.
 *
 * Polls fast, and counts `>=` rather than `===`, because the handshake RETRIES on its own: a
 * caller that means to answer this attempt has to be handed the port before its deadline
 * passes, and a caller that doesn't must not be tripped up by attempt 2 landing mid-poll.
 *
 * Why: `dispatchWebviewEvent` + a hand-rolled `waitFor` is the four-line preamble of nearly
 * every handshake test, and the two indexing decisions above are the ones a re-derivation gets
 * wrong — silently, as a token mismatch that reads like a product bug.
 *
 * @see docs/specs/v0.8.3-player-transport.md §5.5
 */
export async function domReadyTransfer(wv: StubbedWebview): Promise<PortTransfer> {
  const before = wv.transfers.length
  dispatchWebviewEvent(wv, 'dom-ready')
  await vi.waitFor(
    () => {
      expect(wv.transfers.length).toBeGreaterThanOrEqual(before + 1)
    },
    { interval: 10 },
  )
  return wv.transfers[before]!
}

/**
 * Drive one host→guest handshake far enough that a guest is listening: dispatch `dom-ready`,
 * wait for the host's port transfer, and open a fake guest echoing the token the host sent. The
 * caller decides whether that guest ever emits `ready` — the two cases T10 separates.
 *
 * Returning here does NOT mean the channel is published: the host still has to see the ack
 * (spec §5.5 step 6). Callers that go on to invoke must `awaitPublished` first.
 *
 * The guest is opened through `openGuest`, so **your file must `afterEach(destroyGuests)`** —
 * calling this without that leaks a `MessagePort` into every later file in the worker
 * (`isolate: false`), and nothing here will tell you.
 *
 * @see docs/specs/v0.8.3-player-transport.md §5.5 step 6
 */
export async function connectGuest(wv: StubbedWebview): Promise<ReturnType<typeof fakeGuest>> {
  const t = await domReadyTransfer(wv)
  return openGuest(t.port, { ack: String(t.msg) })
}

/**
 * Block until the host has PUBLISHED the channel (spec §5.5 step 6), then hand the guest back
 * with its call counters at zero.
 *
 * `rpc` is module-private on purpose (spec §8.1), so the only host-side observable for
 * "published" is that an invoke round-trips to the guest — and polling that means calling
 * `pause()` an indeterminate number of times. Hence the `mockClear()`: callers count pauses
 * afterwards, and a count that depends on how many times `vi.waitFor` happened to poll is not
 * an assertion. Only the `pause` counter is cleared — `seekTo`/`setRate` are untouched by the
 * poll, so they need no reset.
 *
 * `player` is typed structurally rather than as `ReturnType<typeof getPlayer>` so this module
 * stays free of an import of the code under test.
 *
 * @see docs/specs/v0.8.3-player-transport.md §8.1
 */
export async function awaitPublished(
  player: { pause(): Promise<void> },
  guest: ReturnType<typeof fakeGuest>,
): Promise<void> {
  await vi.waitFor(async () => {
    await player.pause()
    expect(guest.pause).toHaveBeenCalled()
  })
  guest.pause.mockClear()
}
