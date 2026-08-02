// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { dispatchWebviewEvent, fakeGuest } from '../../../../tests/yt-fake-guest'

/** One recorded host→guest port transfer (the `contentWindow.postMessage` in `onDomReady`). */
type PortTransfer = { msg: unknown; port: MessagePort }

/** The parts of the `<webview>` stub a test reads back. */
type StubbedWebview = HTMLElement & {
  executeJavaScript: ReturnType<typeof vi.fn>
  transfers: PortTransfer[]
}

function stubWebview(el: HTMLElement) {
  const ex = vi.fn(async (_code: string, _gesture?: boolean) => undefined)
  // Every host→guest port transfer, in order. A test reads the handshake token back
  // out of `msg` and hands `port` to `fakeGuest` (tests/yt-fake-guest.ts).
  const transfers: PortTransfer[] = []
  Object.assign(el, {
    executeJavaScript: ex,
    insertCSS: vi.fn(async () => 'key'),
    setUserAgent: vi.fn(),
    // happy-dom gives an unknown element no `contentWindow`, so without this the port
    // transfer in `onDomReady` throws into its own catch and every handshake assertion
    // below it is vacuous.
    contentWindow: {
      postMessage: vi.fn((msg: unknown, _origin: string, transfer: Transferable[] = []) => {
        transfers.push({ msg, port: transfer[0] as MessagePort })
      }),
    },
    // Staged for the C6 diagnostic that `onHandshakeFailed()` gains in Task 4 (spec §5.1):
    // it reads the guest's current URL, and an unstubbed `getURL` would throw out of the
    // handshake instead of letting T4/T11 assert. Nothing calls it at this commit.
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

beforeEach(() => {
  const orig = document.createElement.bind(document)
  vi.spyOn(document, 'createElement').mockImplementation(((
    tag: string,
    opts?: ElementCreationOptions,
  ) => {
    const el = orig(tag, opts)
    if (tag === 'webview') stubWebview(el)
    return el
  }) as typeof document.createElement)
})

import { destroyPlayer, getPlayer, handshakeConfig, setPlayerInteractive } from './playerSingleton'

/**
 * `handshakeConfig` is exported mutable module state (spec §5.1), so a test that shrinks a
 * timing to keep its wall-clock sane has to hand it back. Restoring in `afterEach` rather
 * than in the test body is the point: the body's restore is skipped exactly when an
 * assertion throws, which is when a leaked 20ms handshake timeout does the most damage.
 */
const handshakeDefaults = { ...handshakeConfig }

/**
 * Fake guests a test opened, torn down in `afterEach`.
 *
 * Why not `guest.rpc.destroy()` as the test's own last statement: that line is skipped
 * exactly when an assertion throws, so a failing test leaves an open `MessagePort` behind.
 * Under `isolate: false` (`vitest.config.ts`) unrestored state "leaks into unrelated later
 * files and fails them in confusing places" — the lesson `tests/pdf-layout.ts` records
 * (utof/linsae#154).
 */
const guests: ReturnType<typeof fakeGuest>[] = []
function openGuest(...args: Parameters<typeof fakeGuest>): ReturnType<typeof fakeGuest> {
  const g = fakeGuest(...args)
  guests.push(g)
  return g
}

/**
 * Drive one host→guest handshake far enough that a guest is listening: dispatch
 * `dom-ready`, wait for the host's port transfer, and open a fake guest echoing the token
 * the host sent. The caller decides whether that guest ever emits `ready` — the two cases
 * T10 separates.
 */
async function connectGuest(wv: StubbedWebview): Promise<ReturnType<typeof fakeGuest>> {
  const before = wv.transfers.length
  dispatchWebviewEvent(wv, 'dom-ready')
  await vi.waitFor(() => {
    expect(wv.transfers.length).toBe(before + 1)
  })
  const t = wv.transfers[before]!
  return openGuest(t.port, { ack: String(t.msg) })
}

afterEach(() => {
  guests.splice(0).forEach((g) => {
    g.rpc.destroy()
  })
  destroyPlayer()
  Object.assign(handshakeConfig, handshakeDefaults)
  vi.restoreAllMocks()
})

describe('playerSingleton (webview)', () => {
  it('constructs the wrapper+webview exactly once', () => {
    const a = getPlayer()
    expect(getPlayer()).toBe(a)
    expect(a.wrapper.querySelectorAll('webview').length).toBe(1)
  })
  it('load sets the canonical watch src', async () => {
    const p = getPlayer()
    await p.load('M7lc1UVf-VE')
    const wv = p.wrapper.querySelector('webview') as unknown as { src: string }
    expect(wv.src).toBe('https://www.youtube.com/watch?v=M7lc1UVf-VE')
    expect(p.videoId).toBe('M7lc1UVf-VE')
  })
  it('play() grants a user gesture via executeJavaScript(code, true)', async () => {
    const p = getPlayer()
    const wv = p.wrapper.querySelector('webview') as unknown as StubbedWebview
    await p.play()
    expect(wv.executeJavaScript).toHaveBeenCalledWith(expect.any(String), true)
  })
  it('getCurrentTime resolves from the cache with no RPC handshake', async () => {
    const p = getPlayer()
    expect(await p.getCurrentTime()).toBe(0)
  })
  it('getMediaRect returns the webview rect', () => {
    expect(getPlayer().getMediaRect()?.width).toBe(320)
  })
  it('setPlayerInteractive toggles the wrapper pointer-events (drag click-through)', () => {
    const p = getPlayer()
    setPlayerInteractive(false)
    expect(p.wrapper.style.pointerEvents).toBe('none')
    setPlayerInteractive(true)
    expect(p.wrapper.style.pointerEvents).toBe('')
  })
  it('reconstructs after destroyPlayer()', () => {
    const a = getPlayer()
    destroyPlayer()
    expect(getPlayer()).not.toBe(a)
  })
  it('dom-ready injects the guest runtime once and transfers exactly one live port', async () => {
    const p = getPlayer()
    const wv = p.wrapper.querySelector('webview') as unknown as StubbedWebview

    dispatchWebviewEvent(wv, 'dom-ready')

    await vi.waitFor(() => {
      expect(wv.transfers.length).toBe(1)
    })
    const t = wv.transfers[0]!
    const guest = openGuest(t.port, { ack: String(t.msg) })
    // Drop the cover now rather than leaving its 10s timer armed across `afterEach`
    // (`destroyPlayer()` clears it, but a settled cover keeps this test's timing its own).
    guest.emitReady()

    // Round-trips a real invoke to prove the transferred port is LIVE, not merely
    // recorded. `pause()` is the spec's observable for a published channel (§8.1) —
    // `rpc` itself stays module-private on purpose.
    await p.pause()
    expect(guest.pause).toHaveBeenCalledTimes(1)

    expect(wv.executeJavaScript).toHaveBeenCalledTimes(1)
    expect(wv.transfers.length).toBe(1)
  })
  it('mount/unmount keeps the wrapper attached to <body> (never re-parented)', () => {
    const p = getPlayer()
    expect(p.wrapper.parentElement).toBe(document.body)
    const hostEl = document.createElement('div')
    p.mount(hostEl)
    // Positioned OVER the host, not moved into it (moving a <webview> destroys
    // its guest — electron#9529).
    expect(p.wrapper.parentElement).toBe(document.body)
    p.unmount()
    expect(p.wrapper.parentElement).toBe(document.body)
  })
})

/**
 * T10 (spec §8.2). The black cover drops on `ready`-or-timeout and on NOTHING else — both
 * neighbouring designs are regressions, and each half below guards one of them:
 *
 *   - dropping on `ack` reveals YouTube's startup churn as a "muted, plays 1s, then stops"
 *     flash. That was tried (commit 47a05f7) and reverted; spec N5, tracked in #65.
 *   - dropping only on `ready`-or-handshake-*failure* leaves the cover up FOREVER on a
 *     consent wall, where the handshake succeeds and `ready` never fires. Spec N6.
 */
describe('playerSingleton cover (T10)', () => {
  function coverAndSpinner(p: ReturnType<typeof getPlayer>) {
    return {
      wv: p.wrapper.querySelector('webview') as unknown as StubbedWebview,
      cover: p.wrapper.querySelector('#yt-player-cover') as HTMLElement,
      spinner: p.wrapper.querySelector('#yt-player-spinner') as HTMLElement,
    }
  }

  it('drops on the guest `ready` event', async () => {
    const p = getPlayer()
    const { wv, cover, spinner } = coverAndSpinner(p)
    await p.load('M7lc1UVf-VE')
    expect(cover.style.display).toBe('block')

    // The ready timeout is left at its default here on purpose: it is orders of magnitude
    // longer than `vi.waitFor`'s window, so the timer cannot be what drops the cover below.
    const guest = await connectGuest(wv)
    // The guest has ACKED by now — `pause()` round-trips the same port and MessagePort
    // preserves order, so the ack was delivered and processed before this assertion. The
    // cover must STILL be up: dropping on `ack` is the reveal-early regression that was
    // shipped at `47a05f7` and reverted (spec N5, #65). Without this, wiring the drop to
    // `whenAck` instead of `whenReady` passes every other assertion in this file.
    await p.pause()
    expect(guest.pause).toHaveBeenCalledTimes(1)
    expect(cover.style.display).toBe('block')

    guest.emitReady()

    await vi.waitFor(() => {
      expect(cover.style.display).toBe('none')
    })
    // `refreshSpinner` reads the cover's own `display`, so it has to run AFTER the drop.
    // Reversed, it sees a cover that is still up and leaves the spinner turning over a
    // playing video until the next state event happens to re-sync it.
    expect(spinner.style.display).toBe('none')
  })

  it('drops after readyTimeoutMs when `ready` never fires (the consent-wall shape)', async () => {
    // Real timers with a shrunken bound, NOT `vi.useFakeTimers()`: the handshake awaits
    // `safeExec` and MessagePort delivery, and happy-dom groups zero-delay timeouts into one
    // shared Node timer under `isolate: false` (`rpc.test.ts`). Restored in `afterEach`.
    handshakeConfig.readyTimeoutMs = 20
    const p = getPlayer()
    const { wv, cover, spinner } = coverAndSpinner(p)
    await p.load('M7lc1UVf-VE')
    expect(cover.style.display).toBe('block')

    // The guest ACKS — the transport is live, the handshake succeeds — but never hooks a
    // <video>, so it never emits `ready`. That is exactly a consent wall: the page needs a
    // click, and the cover is what stands between the user and giving it.
    await connectGuest(wv)

    await vi.waitFor(() => {
      expect(cover.style.display).toBe('none')
    })
    expect(spinner.style.display).toBe('none')
  })

  it('does not let the previous video’s pending drop reveal the next one', async () => {
    // A drop armed for video A keeps running across `load(B)` and can fire before B's own
    // `dom-ready` re-arms it — revealing a still-loading B (spec N5). HEAD had this same
    // path, not a safer one: its `Promise.race` did not cancel its loser either, and the
    // loser there was the `timeout(10000)` that RAN the drop. So `raiseCover`'s cancel
    // closes a reveal-early hole rather than merely declining to open a new one.
    handshakeConfig.readyTimeoutMs = 300
    const p = getPlayer()
    const { wv, cover } = coverAndSpinner(p)
    await p.load('M7lc1UVf-VE')
    await connectGuest(wv) // arms A's drop; the guest never becomes ready

    // A's deadline must not have passed yet, or `load(B)`'s own raise would restore the
    // cover and this test would pass whether or not `raiseCover` cancels anything.
    expect(cover.style.display).toBe('block')
    await p.load('dQw4w9WgXcQ')
    // Past A's deadline, with no `dom-ready` for B yet — the cover must still be up.
    await new Promise((r) => {
      setTimeout(r, 400)
    })
    expect(cover.style.display).toBe('block')
  })
})
