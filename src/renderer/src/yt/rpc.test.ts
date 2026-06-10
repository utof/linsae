// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { createRpc } from './rpc'

describe('createRpc', () => {
  it('invoke resolves with the handler return across the channel', async () => {
    const { port1, port2 } = new MessageChannel()
    const host = createRpc(port1)
    const guest = createRpc(port2)
    guest.handle('add', (a, b) => (a as number) + (b as number))
    expect(await host.invoke<number>('add', 2, 3)).toBe(5)
    host.destroy()
    guest.destroy()
  })

  it('invoke rejects on timeout when no handler answers', async () => {
    vi.useFakeTimers()
    const { port1 } = new MessageChannel()
    const host = createRpc(port1, { invokeTimeoutMs: 50 })
    const p = host.invoke('missing')
    const assertion = expect(p).rejects.toThrow(/timeout/i)
    await vi.advanceTimersByTimeAsync(60)
    await assertion
    vi.useRealTimers()
    host.destroy()
  })

  it('send/on delivers fire-and-forget events', async () => {
    const { port1, port2 } = new MessageChannel()
    const host = createRpc(port1)
    const guest = createRpc(port2)
    const seen: unknown[] = []
    host.on('tick', (p) => seen.push(p))
    guest.send('tick', 42)
    // Poll instead of a single setTimeout(0) flush: happy-dom groups zero-delay
    // timeouts into one shared Node timer (BrowserWindow.js timeout grouping), so
    // under `isolate: false` worker sharing (vitest.config.ts) the flush could join
    // a group timer armed BEFORE postMessage and resolve before MessagePort delivery.
    await vi.waitFor(() => {
      expect(seen).toEqual([42])
    })
    host.destroy()
    guest.destroy()
  })

  it('whenReady resolves once the peer signals ready', async () => {
    const { port1, port2 } = new MessageChannel()
    const host = createRpc(port1)
    const guest = createRpc(port2)
    guest.signalReady()
    await expect(host.whenReady()).resolves.toBeUndefined()
    host.destroy()
    guest.destroy()
  })
})
