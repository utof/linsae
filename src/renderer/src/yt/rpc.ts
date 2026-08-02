/**
 * Symmetric MessagePort RPC for the webview-backed player (ADR 0016 / spec §4.2).
 * Both ends can invoke()+handle() and send()+on(). Adapted (slimmed, no nanoevents
 * dep) from aidenlx/media-extended (MIT) — apps/app/src/lib/message/index.ts.
 */
type Wire =
  | { t: 'invoke'; id: number; method: string; args: unknown[] }
  | { t: 'res'; id: number; ok: boolean; value?: unknown; error?: string }
  | { t: 'event'; event: string; payload: unknown }
  | { t: 'ready' }
  // `ack` and `ready` are DIFFERENT facts and neither may be inferred from the other:
  // `ack` says the transport is live and is sent before any DOM work (so it fires even on
  // a consent page), `ready` says a `<video>` was hooked. Spec §6.5 / contract C3.
  | { t: 'ack'; token: string }

/**
 * Cap on already-seen ack tokens buffered for `whenAck`'s after-the-fact short-circuit.
 * One channel legitimately sees exactly ONE ack — each handshake attempt builds a fresh
 * `MessageChannel` (spec §5.5 step 2) — so this is 8× headroom, kept finite only so a
 * misbehaving guest cannot grow the set without bound. Note the cap touches ONLY the
 * short-circuit: a `whenAck` waiter registered before its ack is never capped.
 */
const MAX_SEEN_ACKS = 8

export interface Rpc {
  invoke<T = unknown>(method: string, ...args: unknown[]): Promise<T>
  handle(method: string, fn: (...args: unknown[]) => unknown | Promise<unknown>): void
  send(event: string, payload?: unknown): void
  on(event: string, cb: (payload: unknown) => void): () => void
  signalReady(): void
  whenReady(): Promise<void>
  /**
   * Resolves `true` once an `{ t: 'ack' }` echoing exactly `token` has arrived on this
   * channel — including one that arrived BEFORE this call, since seen tokens are buffered
   * (the same hazard `whenReady`'s `isReady` short-circuit closes).
   *
   * Why the token rather than a bare `{ t: 'ack' }`: a late ack from a superseded handshake
   * attempt or a dead document must be inert, never publish a channel (contract C4).
   *
   * Why it never rejects and never self-times-out: the handshake owns the deadline, as
   * `Promise.race([whenAck(token), delay(ackTimeoutMs) → false])` (spec §5.5 step 4). The
   * `false` arm of the return type is therefore always the caller's, never this promise's.
   *
   * @see docs/specs/v0.8.3-player-transport.md §6.6
   * @issue utof/linsae#213
   */
  whenAck(token: string): Promise<boolean>
  destroy(): void
}

export function createRpc(port: MessagePort, opts: { invokeTimeoutMs?: number } = {}): Rpc {
  const invokeTimeoutMs = opts.invokeTimeoutMs ?? 1000
  const handlers = new Map<string, (...a: unknown[]) => unknown>()
  const listeners = new Map<string, Set<(p: unknown) => void>>()
  const pending = new Map<
    number,
    {
      resolve: (v: unknown) => void
      reject: (e: Error) => void
      timer: ReturnType<typeof setTimeout>
    }
  >()
  let nextId = 1
  let isReady = false
  let readyResolve: (() => void) | null = null
  const readyPromise = new Promise<void>((r) => {
    readyResolve = () => {
      isReady = true
      r()
    }
  })
  const seenAcks = new Set<string>()
  const ackWaiters = new Set<{ token: string; resolve: (v: boolean) => void }>()
  const post = (m: Wire, transfer: Transferable[] = []) => port.postMessage(m, transfer)

  port.onmessage = async (e: MessageEvent) => {
    const m = e.data as Wire
    if (m.t === 'invoke') {
      const fn = handlers.get(m.method)
      if (!fn) {
        post({ t: 'res', id: m.id, ok: false, error: `no handler: ${m.method}` })
        return
      }
      try {
        post({ t: 'res', id: m.id, ok: true, value: await fn(...m.args) })
      } catch (err) {
        post({ t: 'res', id: m.id, ok: false, error: String(err) })
      }
    } else if (m.t === 'res') {
      const p = pending.get(m.id)
      if (!p) return
      clearTimeout(p.timer)
      pending.delete(m.id)
      if (m.ok) p.resolve(m.value)
      else p.reject(new Error(m.error))
    } else if (m.t === 'event') {
      listeners.get(m.event)?.forEach((cb) => {
        cb(m.payload)
      })
    } else if (m.t === 'ready') {
      readyResolve?.()
    } else if (m.t === 'ack') {
      if (seenAcks.size < MAX_SEEN_ACKS) seenAcks.add(m.token)
      ackWaiters.forEach((w) => {
        if (w.token === m.token) {
          ackWaiters.delete(w)
          w.resolve(true)
        }
      })
    }
  }
  port.start?.()

  return {
    invoke<T>(method: string, ...args: unknown[]) {
      return new Promise<T>((resolve, reject) => {
        const id = nextId++
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new Error(`rpc invoke timeout: ${method}`))
        }, invokeTimeoutMs)
        pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer })
        post({ t: 'invoke', id, method, args })
      })
    },
    handle(method, fn) {
      handlers.set(method, fn)
    },
    send(event, payload) {
      post({ t: 'event', event, payload: payload ?? null })
    },
    on(event, cb) {
      let set = listeners.get(event)
      if (!set) {
        set = new Set()
        listeners.set(event, set)
      }
      set.add(cb)
      return () => {
        set?.delete(cb)
      }
    },
    signalReady() {
      post({ t: 'ready' })
    },
    whenReady() {
      return isReady ? Promise.resolve() : readyPromise
    },
    whenAck(token) {
      if (seenAcks.has(token)) return Promise.resolve(true)
      return new Promise<boolean>((resolve) => {
        ackWaiters.add({ token, resolve })
      })
    },
    destroy() {
      pending.forEach((p) => {
        clearTimeout(p.timer)
      })
      pending.clear()
      port.onmessage = null
      try {
        port.close()
      } catch {}
    },
  }
}
