import { type Mock, vi } from 'vitest'
import type { VideoFlags } from '../src/renderer/src/yt/player-state'
import { createRpc, type Rpc } from '../src/renderer/src/yt/rpc'

/**
 * Electron builds a webview's DOM events as plain `Event`s carrying extra own
 * properties (`isMainFrame`, `isInPlace`), which `lib.dom`'s `Event` does not
 * declare and `WebviewElement` (`playerSingleton.ts:34-40`) does not type either.
 * @see https://github.com/electron/electron/blob/v42.5.0/lib/renderer/web-view/web-view-impl.ts#L117-L120
 */
type WebviewEventProps = { isMainFrame?: boolean; isInPlace?: boolean }
type WebviewEvent = Event & WebviewEventProps

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
  name: string,
  props: WebviewEventProps = {},
): void {
  const ev: WebviewEvent = Object.assign(new Event(name), props)
  el.dispatchEvent(ev)
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
 * Caller owns teardown: `guest.rpc.destroy()`.
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
    // A FULL payload, deliberately: `applyState` (`playerSingleton.ts:115-117`) writes
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
