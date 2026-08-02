// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { dispatchWebviewEvent, fakeGuest } from '../../../../tests/yt-fake-guest'

/** One recorded host→guest port transfer (`playerSingleton.ts:192`). */
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
    // transfer at `playerSingleton.ts:192` throws into its own catch and every handshake
    // assertion below it is vacuous.
    contentWindow: {
      postMessage: vi.fn((msg: unknown, _origin: string, transfer: Transferable[] = []) => {
        transfers.push({ msg, port: transfer[0] as MessagePort })
      }),
    },
    // The C6 diagnostic reads the guest's current URL (spec §5.1); unstubbed it throws
    // out of the handshake instead of letting the assertion run.
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

import { destroyPlayer, getPlayer, setPlayerInteractive } from './playerSingleton'

afterEach(() => {
  destroyPlayer()
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
    const wv = p.wrapper.querySelector('webview') as unknown as {
      executeJavaScript: ReturnType<typeof vi.fn>
    }
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
    const guest = fakeGuest(t.port, { ack: String(t.msg) })
    // Settle the host's readiness race (`playerSingleton.ts:197`) instead of leaving
    // `onDomReady` pending across `afterEach`'s destroyPlayer() for the full 10s.
    guest.emitReady()

    // Round-trips a real invoke to prove the transferred port is LIVE, not merely
    // recorded. `pause()` is the spec's observable for a published channel (§8.1) —
    // `rpc` itself stays module-private on purpose.
    await p.pause()
    expect(guest.pause).toHaveBeenCalledTimes(1)

    expect(wv.executeJavaScript).toHaveBeenCalledTimes(1)
    expect(wv.transfers.length).toBe(1)
    guest.rpc.destroy()
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
