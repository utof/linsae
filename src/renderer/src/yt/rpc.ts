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

export interface Rpc {
  invoke<T = unknown>(method: string, ...args: unknown[]): Promise<T>
  handle(method: string, fn: (...args: unknown[]) => unknown | Promise<unknown>): void
  send(event: string, payload?: unknown): void
  on(event: string, cb: (payload: unknown) => void): () => void
  signalReady(): void
  whenReady(): Promise<void>
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
