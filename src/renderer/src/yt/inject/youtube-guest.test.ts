import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRpc, type Rpc } from '../rpc'
import { guestRuntime } from './youtube-guest'

/**
 * T9 — execute the REAL guest runtime, twice, in happy-dom.
 *
 * Why this file executes the string instead of asserting on it: `toContain('__linsaeGuest')`
 * survives `if (false && …)`, survives a sentinel that is written but never read, and survives
 * the identifier appearing only in a comment (spec §8.2). Every API the guest touches on the
 * no-video path exists in happy-dom — `querySelector` returns null, so `setupObserver` falls
 * back to `document.body` — so the whole runtime really runs here.
 *
 * @see docs/specs/v0.8.3-player-transport.md §6.1–§6.5, contract C5
 */

/** The guest's own global, installed once per document (spec §6.1). */
type GuestWindow = Window & { __linsaeGuest?: { arm(token: string): void } }

/**
 * Counts of the single-instance-per-document things the guest installs. A second injection
 * must add NONE of them (C5); without the sentinel every field doubles.
 */
interface GuestFootprint {
  setInterval: number
  mutationObserver: number
  windowMessage: number
  documentKeydown: number
}

/**
 * Records what the guest installs, in order, and hands back the handles needed to undo it.
 *
 * Cleanup is the test's job, not the guest's: the runtime starts three 200ms `setInterval`s
 * per document (autoplay poll, unmute poll, video poll) that outlive the test by up to 20s,
 * and `vitest.config.ts` runs this project with `isolate: false`, so a leaked timer keeps
 * ticking inside another file's run. The guest exposes no teardown of its own — it is written
 * for a document that gets thrown away — so the probe collects every id/instance/listener it
 * sees and `dispose()` unwinds them.
 */
function probeGuest(): {
  /** Every recorded action since the last `reset()`, in order. */
  timeline: string[]
  counts(): GuestFootprint
  reset(): void
  dispose(): void
} {
  const timeline: string[] = []
  const intervals: number[] = []
  const observers: MutationObserver[] = []
  const added: {
    target: EventTarget
    type: string
    fn: EventListenerOrEventListenerObject
    opts: boolean | AddEventListenerOptions | undefined
  }[] = []

  const realSetInterval = globalThis.setInterval
  const RealObserver = globalThis.MutationObserver
  const realWindowAdd = window.addEventListener.bind(window)
  const realDocumentAdd = document.addEventListener.bind(document)

  vi.spyOn(globalThis, 'setInterval').mockImplementation(((fn: TimerHandler, ms?: number) => {
    timeline.push('setInterval')
    const id = realSetInterval(fn, ms)
    intervals.push(id)
    return id
  }) as unknown as typeof globalThis.setInterval)

  class ProbeObserver extends RealObserver {
    constructor(cb: MutationCallback) {
      super(cb)
      timeline.push('MutationObserver')
      observers.push(this)
    }
  }
  globalThis.MutationObserver = ProbeObserver as unknown as typeof MutationObserver

  const spyAdd = (
    target: EventTarget,
    label: string,
    real: (
      type: string,
      fn: EventListenerOrEventListenerObject,
      opts?: boolean | AddEventListenerOptions,
    ) => void,
  ) => {
    vi.spyOn(target, 'addEventListener').mockImplementation(((
      type: string,
      fn: EventListenerOrEventListenerObject,
      opts?: boolean | AddEventListenerOptions,
    ) => {
      timeline.push(`${label}:${type}`)
      added.push({ target, type, fn, opts })
      real(type, fn, opts)
    }) as unknown as typeof target.addEventListener)
  }
  spyAdd(window, 'window', realWindowAdd)
  spyAdd(document, 'document', realDocumentAdd)

  const tally = (mark: string) => timeline.filter((m) => m === mark).length

  return {
    timeline,
    counts: () => ({
      setInterval: tally('setInterval'),
      mutationObserver: tally('MutationObserver'),
      windowMessage: tally('window:message'),
      documentKeydown: tally('document:keydown'),
    }),
    reset: () => {
      timeline.length = 0
    },
    dispose: () => {
      for (const id of intervals) clearInterval(id)
      for (const o of observers) o.disconnect()
      // `removeEventListener` is not spied, so this is the real one — and the capture flag
      // has to travel with it: the guest's `keydown` stopper is registered with `true`, and a
      // remove that omits it silently leaves the listener installed.
      for (const l of added) l.target.removeEventListener(l.type, l.fn, l.opts)
      globalThis.setInterval = realSetInterval
      globalThis.MutationObserver = RealObserver
      vi.restoreAllMocks()
      delete (window as GuestWindow).__linsaeGuest
    },
  }
}

/** Run the runtime string the way `playerSingleton`'s `safeExec` does — in global scope. */
function inject(token: string): void {
  new Function(guestRuntime(token))()
}

/**
 * Hand the guest a live port the way the host's `contentWindow.postMessage(token, '*', [port])`
 * does. `window.postMessage(data, '*', [port])` cannot be used here: happy-dom silently drops
 * the transfer list (measured — `e.ports.length === 0`), while a hand-built `MessageEvent`
 * delivers a live port. `dispatchEvent` is synchronous, so the guest's receiver — and, through
 * it, `initPort` — has fully run by the time this returns.
 *
 * @see docs/specs/v0.8.3-player-transport.md §8.1
 */
function deliverPort(token: string, port: MessagePort | null): void {
  window.dispatchEvent(new MessageEvent('message', { data: token, ports: port ? [port] : [] }))
}

/** Record every wire message the guest posts, tagged by its `t`, into the probe's timeline. */
function watchPort(port: MessagePort, timeline: string[]): void {
  const real = port.postMessage.bind(port)
  vi.spyOn(port, 'postMessage').mockImplementation(((msg: unknown, transfer?: Transferable[]) => {
    timeline.push(`post:${(msg as { t?: string }).t ?? '?'}`)
    real(msg, transfer ?? [])
  }) as unknown as typeof port.postMessage)
}

/** Channels handed to the guest; closed in `afterEach` so no port outlives its test. */
const open: { host: Rpc; guestPort: MessagePort }[] = []

/** A real `MessageChannel` with a real host-side `createRpc` — the far end goes to the guest. */
function channel(): { host: Rpc; guestPort: MessagePort } {
  const { port1, port2 } = new MessageChannel()
  const c = { host: createRpc(port1), guestPort: port2 }
  open.push(c)
  return c
}

/**
 * `whenAck` raced against a short deadline. `whenAck` never resolves `false` and never times
 * out on its own (`rpc.ts`), so a broken round trip would otherwise hang until vitest's 5s
 * default and report as a timeout rather than as an assertion.
 */
function ackWithin(host: Rpc, token: string): Promise<boolean | 'timed-out'> {
  return Promise.race([
    host.whenAck(token),
    new Promise<'timed-out'>((r) => {
      setTimeout(() => {
        r('timed-out')
      }, 200)
    }),
  ])
}

describe('guestRuntime — idempotent injection, re-armable receiver (C5)', () => {
  afterEach(() => {
    for (const c of open) {
      c.host.destroy()
      c.guestPort.close()
    }
    open.length = 0
  })

  it('a second injection re-arms the receiver instead of installing a second runtime', async () => {
    const probe = probeGuest()
    try {
      // The counts are ZERO at injection time — every interval, observer and the keydown
      // stopper lives inside `initPort`, which runs only once a port arrives. So the
      // measurement has to be inject+deliver, twice, not inject twice (spec §8.2 T9).
      const a = channel()
      inject('nonce:1')
      deliverPort('nonce:1', a.guestPort)
      const first = probe.counts()
      probe.reset()

      const b = channel()
      inject('nonce:2')
      deliverPort('nonce:2', b.guestPort)
      const second = probe.counts()

      // What one document's worth of guest costs: the autoplay/unmute/video polls, the
      // consent + re-hook observers, the port receiver, the keydown stopper.
      expect(first).toEqual({
        setInterval: 3,
        mutationObserver: 2,
        windowMessage: 1,
        documentKeydown: 1,
      })
      // C5: the second injection adds none of it.
      expect(second).toEqual({
        setInterval: 0,
        mutationObserver: 0,
        windowMessage: 0,
        documentKeydown: 0,
      })
      // …and the second port was still HONOURED — `initPort` ran for token 2, which is what
      // `arm` exists to make possible. Asserting the ack rather than "arm was called" is the
      // point: an `arm` that records the token and a receiver that never re-matches it would
      // satisfy the weaker claim while leaving the handshake exactly as broken as HEAD's.
      expect(await ackWithin(b.host, 'nonce:2')).toBe(true)
    } finally {
      probe.dispose()
    }
  })

  it('acks over a real MessageChannel to a real createRpc, and answers a real invoke', async () => {
    const probe = probeGuest()
    try {
      const c = channel()
      inject('nonce:7')
      deliverPort('nonce:7', c.guestPort)

      // The two wire formats are hand-duplicated by design (spec §D9) and drift between them
      // is SILENT — an unknown `t` falls off the end of `createRpc`'s `else if` chain and is
      // dropped without error. This is the only place they are pinned against each other.
      expect(await ackWithin(c.host, 'nonce:7')).toBe(true)
      // The invoke/res halves of the same duplicated format, in both directions. `pause`
      // returns null with no `<video>` attached, which is the no-video path happy-dom gives us.
      await expect(c.host.invoke('pause')).resolves.toBeNull()
    } finally {
      probe.dispose()
    }
  })

  it('sends the ack as the first act of initPort, before any DOM work (C3)', async () => {
    const probe = probeGuest()
    try {
      const c = channel()
      watchPort(c.guestPort, probe.timeline)
      inject('nonce:9')
      // Drop the injection's own footprint (the receiver registration); what is being ordered
      // is everything `initPort` does, and `deliverPort` runs all of it synchronously.
      probe.reset()
      deliverPort('nonce:9', c.guestPort)

      // C3: `ack` says only "the transport is live" and must be sent before the guest touches
      // the document at all — that is what makes it fire on a consent page that has no
      // `<video>`, where `ready` never comes.
      expect(probe.timeline[0]).toBe('post:ack')
      // Not vacuous: the DOM work really did happen in the same synchronous slice, after it.
      expect(probe.timeline).toContain('setInterval')
      expect(probe.timeline).toContain('document:keydown')
      expect(probe.timeline).toContain('MutationObserver')
    } finally {
      probe.dispose()
    }
  })

  it('ignores a port offered with a superseded token, leaving the live channel alone', async () => {
    const probe = probeGuest()
    try {
      const a = channel()
      inject('nonce:1')
      deliverPort('nonce:1', a.guestPort)
      const b = channel()
      inject('nonce:2')
      deliverPort('nonce:2', b.guestPort)
      expect(await ackWithin(b.host, 'nonce:2')).toBe(true)

      // A late transfer from a superseded attempt (contract C4's guest-side half): the
      // receiver re-armed to token 2, so token 1 is no longer a key to this document.
      const stale = channel()
      deliverPort('nonce:1', stale.guestPort)
      expect(await ackWithin(stale.host, 'nonce:1')).toBe('timed-out')
      // The live channel survived it — `initPort` never ran, so it never destroyed b's rpc.
      await expect(b.host.invoke('pause')).resolves.toBeNull()
    } finally {
      probe.dispose()
    }
  })

  it('ignores a token-matching message that carries no transferred port', async () => {
    const probe = probeGuest()
    try {
      const c = channel()
      inject('nonce:4')
      deliverPort('nonce:4', c.guestPort)
      expect(await ackWithin(c.host, 'nonce:4')).toBe(true)

      // Reachable, not theoretical: happy-dom's own `window.postMessage(data, '*', [port])`
      // drops the transfer list, and any page script may post a string. Without the
      // `ports.length === 1` check this reaches `initPort`, which destroys the LIVE rpc and
      // then throws on an undefined port — a working channel killed by a stray message.
      deliverPort('nonce:4', null)
      await expect(c.host.invoke('pause')).resolves.toBeNull()
    } finally {
      probe.dispose()
    }
  })

  it('does not double the media-event listeners when a <video> is already hooked', async () => {
    // Every other test here runs against an EMPTY document, so `findVideo()` always fails and
    // `attachVideo()` never runs — which means the 11 media-event listeners that spec §6.1
    // lists FIRST among C5's hazards are unobserved by all of them. Without this test, moving
    // `findVideo()`/`attachVideo()` back out of `wireDocument()` keeps the whole file green
    // while re-arming doubles those 11 per channel.
    document.body.innerHTML = '<ytd-app><div id="movie_player"><video></video></div></ytd-app>'
    const video = document.querySelector('video')!
    const perVideo: string[] = []
    const realAdd = video.addEventListener.bind(video)
    vi.spyOn(video, 'addEventListener').mockImplementation(((
      type: string,
      fn: EventListenerOrEventListenerObject,
      opts?: boolean | AddEventListenerOptions,
    ) => {
      perVideo.push(type)
      realAdd(type, fn, opts)
    }) as unknown as typeof video.addEventListener)

    const probe = probeGuest()
    try {
      const a = channel()
      inject('nonce:5')
      deliverPort('nonce:5', a.guestPort)
      // The guest found the <video> and hooked it — otherwise the assertion below is vacuous
      // for the same reason the empty-document tests cannot see this path at all.
      expect(perVideo.length).toBeGreaterThan(0)
      const hooked = perVideo.length
      expect(await ackWithin(a.host, 'nonce:5')).toBe(true)

      const b = channel()
      inject('nonce:6')
      deliverPort('nonce:6', b.guestPort)
      // C5 on the with-video path: the re-armed channel is live, and not one extra listener
      // was attached to the same element.
      expect(await ackWithin(b.host, 'nonce:6')).toBe(true)
      expect(perVideo.length).toBe(hooked)
    } finally {
      probe.dispose()
      document.body.innerHTML = ''
    }
  })
})
