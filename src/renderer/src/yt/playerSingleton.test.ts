// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { dispatchWebviewEvent, fakeGuest } from '../../../../tests/yt-fake-guest'

/** One recorded host→guest port transfer (the `contentWindow.postMessage` in `handshake()`). */
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
    // transfer in `handshake()` throws into its own catch and every handshake assertion
    // below it is vacuous.
    contentWindow: {
      postMessage: vi.fn((msg: unknown, _origin: string, transfer: Transferable[] = []) => {
        transfers.push({ msg, port: transfer[0] as MessagePort })
      }),
    },
    // Read by the C6 diagnostic in `onHandshakeFailed()` (spec §5.1): it names the guest's
    // current URL, and an unstubbed `getURL` would throw out of the handshake instead of
    // letting T4 assert.
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
 * Dispatch `dom-ready` and resolve the ONE port transfer it produces — `{ msg: token,
 * port }`, the raw material every handshake test works from.
 *
 * Indexed from a watermark rather than from 0 because the token is per-attempt (spec §5.5):
 * a test that drives a second document must read the second transfer's token, not the first.
 *
 * Polls fast, and counts `>=` rather than `===`, because the handshake RETRIES on its own: a
 * caller that means to answer this attempt has to be handed the port before its deadline
 * passes, and a caller that doesn't must not be tripped up by attempt 2 landing mid-poll.
 */
async function domReadyTransfer(wv: StubbedWebview): Promise<PortTransfer> {
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
 * Drive one host→guest handshake far enough that a guest is listening: dispatch
 * `dom-ready`, wait for the host's port transfer, and open a fake guest echoing the token
 * the host sent. The caller decides whether that guest ever emits `ready` — the two cases
 * T10 separates.
 *
 * Returning here does NOT mean the channel is published: the host still has to see the ack
 * (spec §5.5 step 6). Callers that go on to invoke must `awaitPublished` first.
 */
async function connectGuest(wv: StubbedWebview): Promise<ReturnType<typeof fakeGuest>> {
  const t = await domReadyTransfer(wv)
  return openGuest(t.port, { ack: String(t.msg) })
}

/**
 * Block until the host has PUBLISHED the channel (spec §5.5 step 6), then hand the guest
 * back with its call counters at zero.
 *
 * `rpc` is module-private on purpose (spec §8.1), so the only host-side observable for
 * "published" is that an invoke round-trips to the guest — and polling that means calling
 * `pause()` an indeterminate number of times. Hence the `mockClear()`: every caller below
 * counts pauses afterwards, and a count that depends on how many times `vi.waitFor` happened
 * to poll is not an assertion. Only the `pause` counter is cleared — `seekTo`/`setRate` are
 * untouched by the poll, so they need no reset.
 */
async function awaitPublished(
  p: ReturnType<typeof getPlayer>,
  guest: ReturnType<typeof fakeGuest>,
): Promise<void> {
  await vi.waitFor(async () => {
    await p.pause()
    expect(guest.pause).toHaveBeenCalled()
  })
  guest.pause.mockClear()
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
    await awaitPublished(p, guest)
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

  it('unmount pauses through the guest even with no channel published (§5.9)', async () => {
    const p = getPlayer()
    const wv = p.wrapper.querySelector('webview') as unknown as StubbedWebview
    await p.load('M7lc1UVf-VE')
    // No handshake here, so `rpc` is null — the window §5.9 exists for. It is not a corner
    // case: it lasts for as long as the handshake runs (up to `maxAttempts × ackTimeoutMs`),
    // and closing the pane inside it used to leave the video AUDIBLE with nothing on screen.
    p.unmount()
    expect(wv.executeJavaScript).toHaveBeenCalledWith(
      expect.stringContaining('.pause()'),
      undefined,
    )
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
    await awaitPublished(p, guest)
    // The guest has ACKED by now — `awaitPublished` proved it, since the host publishes on
    // nothing else, and `pause()` round-trips the same port afterwards. The
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

/**
 * T1, T4, T5, T6 (spec §8.2) — the #213 half: `rpc` is non-null IFF the guest document that
 * is currently committed has acknowledged the channel (contract C1).
 *
 * Every assertion here is made through `pause()`. `rpc` stays module-private (spec §8.1), and
 * an invoke that reaches a given fake guest is the only proof that THAT guest owns the
 * channel — a port that was merely transferred proves nothing, which is precisely the bug.
 */
describe('playerSingleton handshake (T1, T4, T5, T6)', () => {
  /** `console.warn` calls that are the C6 diagnostic, and not one of the other warners. */
  function diagnostics(warn: { mock: { calls: unknown[][] } }): unknown[][] {
    // Filtered by prefix on purpose: `safeExec` and `safeInsertCSS` warn on the same console
    // in the same handler, so an unfiltered spy counts the wrong calls (spec §8.2, T4).
    return warn.mock.calls.filter((c) => String(c[0]).startsWith('[player] handshake failed'))
  }

  it('re-arms on the second dom-ready: the newer guest owns the channel (T1)', async () => {
    const p = getPlayer()
    const wv = p.wrapper.querySelector('webview') as unknown as StubbedWebview

    const first = await connectGuest(wv)
    await awaitPublished(p, first)

    // A second committed document. On HEAD this is refused outright by `if (rpc || !wv)`,
    // which is #213: the first document to fire `dom-ready` — a consent wall, a redirect —
    // keeps the channel forever and the real watch page never gets one.
    const second = await connectGuest(wv)
    await awaitPublished(p, second)

    expect(wv.transfers.length).toBe(2)
    expect(wv.transfers[0]!.port).not.toBe(wv.transfers[1]!.port)
    // Each attempt carries its own token, so a late ack from the first cannot publish (C4).
    expect(wv.transfers[0]!.msg).not.toBe(wv.transfers[1]!.msg)

    // The live channel is the SECOND one. Asserting only that the second guest hears the
    // invoke would pass while both are hooked; the zero on the first is what pins "never
    // survives its document" (C1).
    await p.pause()
    expect(second.pause).toHaveBeenCalledTimes(1)
    expect(first.pause).toHaveBeenCalledTimes(0)
  })

  it('gives up after maxAttempts and says so exactly once when the guest never acks (T4)', async () => {
    // Shrunken so the three attempts plus their backoffs are ~45ms rather than ~9s. Restored
    // in `afterEach` — real timers, never `vi.useFakeTimers()` (spec §8.1).
    handshakeConfig.ackTimeoutMs = 10
    handshakeConfig.retryBackoffMs = 5
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const p = getPlayer()
    const wv = p.wrapper.querySelector('webview') as unknown as StubbedWebview

    dispatchWebviewEvent(wv, 'dom-ready')

    await vi.waitFor(() => {
      expect(diagnostics(warn).length).toBe(1)
    })
    // Settle past another whole attempt's worth of wall clock: "exactly one" is the claim,
    // and `vi.waitFor` returns the instant the count first reaches 1.
    await new Promise((r) => {
      setTimeout(r, 60)
    })
    expect(diagnostics(warn).length).toBe(1)
    expect(wv.executeJavaScript).toHaveBeenCalledTimes(handshakeConfig.maxAttempts)
    expect(wv.transfers.length).toBe(handshakeConfig.maxAttempts)
    // C6: the diagnostic has to name the document it gave up on, or it cannot be acted on.
    // Joined rather than indexed so it holds whether the URL is interpolated or a second arg.
    expect(diagnostics(warn)[0]!.join(' ')).toContain('https://www.youtube.com/watch?v=M7lc1UVf-VE')
    // The whole point of `.catch()`ing the handshake rather than `void`-ing it (plan item 7):
    // a throw inside it must not reach the runner as an unhandled rejection.
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('handshake threw')).length).toBe(0)

    // Exhausted means UNPUBLISHED, not "published to a guest that never spoke": a guest that
    // only now starts listening on the first transferred port hears nothing.
    const guest = openGuest(wv.transfers[0]!.port, { ack: false })
    await p.pause()
    expect(guest.pause).not.toHaveBeenCalled()
  })

  it('drops an ack that echoes the wrong token, and publishes on the right one (T5)', async () => {
    // Long enough that the stale ack below reaches attempt 1 while it is still LIVE — an ack
    // posted after its candidate was discarded would land on a closed port and this test
    // would pass no matter what `whenAck` did with the token.
    handshakeConfig.ackTimeoutMs = 200
    handshakeConfig.retryBackoffMs = 5
    const p = getPlayer()
    const wv = p.wrapper.querySelector('webview') as unknown as StubbedWebview

    const t0 = await domReadyTransfer(wv)
    // Answers on the wire, but echoes a token this attempt never sent — the shape of an ack
    // from a superseded attempt or a document that has already gone away (contract C4).
    const stale = openGuest(t0.port, { ack: `${String(t0.msg)}-superseded` })

    // The attempt must run out its deadline and RETRY, which is the observable that the ack
    // was refused. Asserting `stale.pause` alone here would be an assertion into an empty
    // window — nothing would have happened yet either way.
    const t1 = await vi.waitFor(() => {
      expect(wv.transfers.length).toBe(2)
      return wv.transfers[1]!
    })
    await p.pause()
    expect(stale.pause).not.toHaveBeenCalled()

    // The next attempt echoes correctly and publishes, so this is not merely a test that the
    // handshake never publishes at all.
    const fresh = openGuest(t1.port, { ack: String(t1.msg) })
    await awaitPublished(p, fresh)
    await p.pause()
    expect(fresh.pause).toHaveBeenCalledTimes(1)
    expect(stale.pause).not.toHaveBeenCalled()
  })

  it('does not publish on the port transfer — only on the ack that follows it (T6)', async () => {
    const p = getPlayer()
    const wv = p.wrapper.querySelector('webview') as unknown as StubbedWebview

    // Everything a channel needs EXCEPT the ack: the runtime is injected, the port is
    // transferred, and a guest is listening on the far end of it. HEAD would have published
    // before any of that (`rpc = createRpc(port1)` ahead of both), which is #213's narrow
    // half — the guest swaps documents in this window and the port is orphaned.
    const t = await domReadyTransfer(wv)
    const guest = openGuest(t.port, { ack: false })
    await p.pause()
    expect(guest.pause).not.toHaveBeenCalled()

    // The one missing fact, supplied by hand rather than at construction so that the "before"
    // window above is real and not a race.
    t.port.postMessage({ t: 'ack', token: String(t.msg) })

    await awaitPublished(p, guest)
    await p.pause()
    expect(guest.pause).toHaveBeenCalledTimes(1)
  })
})
