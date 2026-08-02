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

/**
 * `console.warn` calls that are the C6 diagnostic, and not one of the other warners.
 *
 * Filtered by prefix on purpose: `safeExec` and `safeInsertCSS` warn on the same console in
 * the same handler, so an unfiltered spy counts the wrong calls (spec §8.2, T4). Shared by
 * T4 and T11 — the two tests whose whole claim is "exactly one diagnostic".
 */
function diagnostics(warn: { mock: { calls: unknown[][] } }): unknown[][] {
  return warn.mock.calls.filter((c) => String(c[0]).startsWith('[player] handshake failed'))
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

/**
 * T2, T3, T7, T11 (spec §8.2) — contract C2 (every main-frame CROSS-document navigation
 * invalidates the channel and the value cache; an in-page one does not) and the half of C6
 * that a navigation owns (a navigation that starts and never commits must not leave the
 * player silently dead).
 *
 * Every cache assertion here is preceded by a proof that the cache was SEEDED
 * (`publishAndSeed`). A cache that was never written cannot be observed to be cleared, and
 * without that proof T2 and T7 pass against an implementation that never caches anything —
 * two tests in this file were already found green under the very regression their docstring
 * claimed to guard.
 */
describe('playerSingleton navigation (T2, T3, T7, T11)', () => {
  /**
   * A FULL `VideoFlags` payload. `{ duration: 213 }` alone leaves `currentTime` undefined,
   * which `applyState` writes straight into the cache — the next cache assertion then reads
   * a lie (spec §8.1).
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
   * Publish a channel and seed the value cache through it, in the ONE order that works: the
   * host attaches its `state` listener at publish (spec §5.5 step 6), so an `emitState`
   * posted before the ack lands on a channel with no listener and silently seeds nothing.
   *
   * Returns with the guest's `pause` counter at zero (`awaitPublished` clears it) and with
   * `getDuration()` proven to be 213 — the "something has provably happened" the negative
   * assertions below are measured against.
   */
  async function publishAndSeed(
    p: ReturnType<typeof getPlayer>,
    wv: StubbedWebview,
  ): Promise<ReturnType<typeof fakeGuest>> {
    const guest = await connectGuest(wv)
    await awaitPublished(p, guest)
    guest.emitState(SEEDED)
    await vi.waitFor(async () => {
      expect(await p.getDuration()).toBe(213)
    })
    return guest
  }

  it('a cross-document navigation kills the channel and the value cache (T2)', async () => {
    const p = getPlayer()
    const wv = p.wrapper.querySelector('webview') as unknown as StubbedWebview
    const guest = await publishAndSeed(p, wv)

    // The event Electron fires the instant a main-frame navigation STARTS — before anything
    // commits, and possibly before anything ever does (T11).
    dispatchWebviewEvent(wv, 'did-start-navigation', { isMainFrame: true, isInPlace: false })

    // Both halves of C2, and both halves of this milestone: #213 is the channel not being
    // invalidated, #211 is the cache not being invalidated. One `teardown()` owns both.
    await p.pause()
    expect(guest.pause).not.toHaveBeenCalled()
    expect(await p.getDuration()).toBeNull()
  })

  it('an in-page navigation leaves both alone (T3 — paired with T2, not evidence alone)', async () => {
    // T3 passes against an EMPTY implementation and on HEAD: no listener at all also fails
    // to tear down. It is meaningful only next to T2, where the same dispatch with
    // `isInPlace: false` must produce the opposite outcome (spec §8.2).
    const p = getPlayer()
    const wv = p.wrapper.querySelector('webview') as unknown as StubbedWebview
    const guest = await publishAndSeed(p, wv)

    // YouTube's own SPA route change. The JS world — and with it the guest runtime holding
    // the far end of the port — survives it, so tearing down here would destroy a channel
    // that is still perfectly good.
    dispatchWebviewEvent(wv, 'did-start-navigation', { isMainFrame: true, isInPlace: true })

    await p.pause()
    expect(guest.pause).toHaveBeenCalledTimes(1)
    expect(await p.getDuration()).toBe(213)
  })

  it('load(B) drops the duration video A seeded (T7)', async () => {
    const p = getPlayer()
    const wv = p.wrapper.querySelector('webview') as unknown as StubbedWebview
    await p.load('M7lc1UVf-VE')
    const guest = await publishAndSeed(p, wv)

    await p.load('dQw4w9WgXcQ')

    // #211 exactly: `getDuration()` returning A's 213 here is latched by `usePlayerState`'s
    // first non-null read and written to B's `video_sources` row by `ThreadView`'s
    // `durationWrittenRef` — on disk, surviving restart.
    await p.pause()
    expect(guest.pause).not.toHaveBeenCalled()
    expect(await p.getDuration()).toBeNull()
  })

  it('load(B) invalidates a handshake still IN FLIGHT for A (T7, §5.7)', async () => {
    // The half a clean `load(A)` → `load(B)` cannot see. `load()` nulling `rpc` inline (what
    // it did before §5.7) does not bump `handshakeSeq`, so an attempt already past its port
    // transfer survives the load and publishes the OUTGOING document's channel — A's guest
    // then feeds A's duration into B's cache. HEAD had no such path: it published
    // synchronously in the `dom-ready` handler, so `load()`'s null was final.
    // Long enough that attempt 1 is still LIVE when `load` runs below. At a short deadline
    // the attempt has already timed out and been discarded by the time the harness reads its
    // token back, `t.port` belongs to nobody, and every assertion here passes vacuously —
    // measured: at `ackTimeoutMs = 10` this test was green against the unfixed `load()`.
    handshakeConfig.ackTimeoutMs = 200
    const p = getPlayer()
    const wv = p.wrapper.querySelector('webview') as unknown as StubbedWebview
    await p.load('M7lc1UVf-VE')
    // In flight: the runtime is injected and the port is transferred, but no ack yet.
    const t = await domReadyTransfer(wv)
    // A retry would mean attempt 1's deadline had already passed. This is the guard on the
    // vacuity above — it is the observable for "the attempt `load` is about to supersede
    // still exists".
    expect(wv.transfers.length).toBe(1)

    await p.load('dQw4w9WgXcQ')

    // Only NOW does A's document answer — with the token that was current when `load` ran.
    const guestA = openGuest(t.port, { ack: String(t.msg) })
    guestA.emitState(SEEDED)

    // A bounded settle, not an empty window: the in-flight attempt resolves within
    // `ackTimeoutMs` of its transfer whichever way it goes (ack or deadline), and a
    // MessagePort delivers in FIFO order, so the `state` post above is drained after the ack
    // that would have published the channel.
    await new Promise((r) => {
      setTimeout(r, 300)
    })

    await p.pause()
    expect(guestA.pause).not.toHaveBeenCalled()
    expect(await p.getDuration()).toBeNull()
    // The state the corruption is measured against: A's value would be written to B's row.
    expect(p.videoId).toBe('dQw4w9WgXcQ')
  })

  it('a navigation that never commits does not leave the player silently dead (T11)', async () => {
    // Shrunken so the watchdog plus a whole exhausted handshake is ~350ms rather than ~13s.
    // Real timers, never `vi.useFakeTimers()`; restored in `afterEach` (spec §8.1).
    // `ackTimeoutMs` is deliberately NOT shrunk to single digits: the first handshake below
    // has to publish, and a deadline shorter than the harness takes to read the token back
    // and ack would retry underneath it — the attempt the guest answers would already be
    // superseded, and the test would fail in `awaitPublished` long before reaching its claim.
    handshakeConfig.armWatchdogMs = 20
    handshakeConfig.ackTimeoutMs = 100
    handshakeConfig.retryBackoffMs = 5
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const p = getPlayer()
    const wv = p.wrapper.querySelector('webview') as unknown as StubbedWebview

    // Publish first: the null state below is one the watchdog has to RESCUE, not the state
    // the module happens to start in.
    const guest = await connectGuest(wv)
    await awaitPublished(p, guest)

    // A navigation starts and nothing ever commits, so no `dom-ready` follows it. Our own
    // main process does this to every guest navigation off the allowlist (`src/main/index.ts`,
    // the `will-navigate` handler's `GUEST_HOST_ALLOW` test); 204/205 responses,
    // `Content-Disposition` downloads and BFCache restores are the upstream cases.
    dispatchWebviewEvent(wv, 'did-start-navigation', { isMainFrame: true, isInPlace: false })
    await p.pause()
    expect(guest.pause).not.toHaveBeenCalled()

    // C6: the channel is dead, and something must SAY so within a bounded time. Without the
    // watchdog nothing re-enters the handshake — `dom-ready` is the only other door and it
    // is never coming — so this waits out its timeout in silence, which is the state the
    // player is in on HEAD whenever `src/main/index.ts` cancels a guest hop.
    await vi.waitFor(() => {
      expect(diagnostics(warn).length).toBe(1)
    })
    // "Exactly one" is the claim, and `vi.waitFor` returns the instant the count first
    // reaches 1. Settle past another whole attempt's worth of wall clock.
    await new Promise((r) => {
      setTimeout(r, 60)
    })
    expect(diagnostics(warn).length).toBe(1)
    expect(diagnostics(warn)[0]!.join(' ')).toContain('https://www.youtube.com/watch?v=M7lc1UVf-VE')
  })

  it('a navigation that never commits still drops the cover (T11 sibling, N6)', async () => {
    // `teardown()` clears `coverTimer` (spec §5.2 step 5), and the navigation path's whole
    // premise is that no `dom-ready` is coming to re-arm it. Without a re-arm on this path
    // the cover is left up with no pending drop and no event that will ever schedule one —
    // a permanent black screen over the page the user has to click. HEAD does not have this:
    // its 10s cover timeout, once a document had committed, was uncancellable.
    //
    // T11 above cannot see it: it asserts on the channel and the diagnostic, not on the DOM.
    //
    // The two deadlines are different ON PURPOSE, and that is what makes this discriminating
    // rather than merely true. A's drop is armed for a deadline no `vi.waitFor` will ever
    // wait out, so the only drop this test can observe is one armed AFTER the navigation. If
    // the navigation path re-armed nothing, the cover would either hang on A's 5s timer
    // (no listener at all) or hang forever (`teardown()` swept it and nothing replaced it).
    handshakeConfig.readyTimeoutMs = 5000
    const p = getPlayer()
    const wv = p.wrapper.querySelector('webview') as unknown as StubbedWebview
    const cover = p.wrapper.querySelector('#yt-player-cover') as HTMLElement
    await p.load('M7lc1UVf-VE')
    // A commits, so a drop IS pending — the state `teardown()` is about to sweep. Without
    // this the test would only prove the weaker "arm on a cover that had nothing armed".
    await connectGuest(wv)
    expect(cover.style.display).toBe('block')

    handshakeConfig.readyTimeoutMs = 20
    dispatchWebviewEvent(wv, 'did-start-navigation', { isMainFrame: true, isInPlace: false })

    await vi.waitFor(() => {
      expect(cover.style.display).toBe('none')
    })
  })
})
