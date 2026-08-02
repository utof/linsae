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

  // `{ t: 'ack', token }` is posted RAW here rather than through a peer `createRpc`: the
  // ack sender lives only on the guest's hand-duplicated rpc (`inject/youtube-guest.ts`),
  // because the host never acks. This is the same raw post `tests/yt-fake-guest.ts` makes.
  it('whenAck resolves true when the peer acks the matching token', async () => {
    const { port1, port2 } = new MessageChannel()
    const host = createRpc(port1)
    const acked = host.whenAck('nonce:1')
    port2.postMessage({ t: 'ack', token: 'nonce:1' })
    await expect(acked).resolves.toBe(true)
    host.destroy()
  })

  it('whenAck stays pending when the peer acks a different token', async () => {
    const { port1, port2 } = new MessageChannel()
    const host = createRpc(port1)
    const wanted = host.whenAck('nonce:2')
    // Registered on the SAME channel and resolved below, so the mismatch assertion cannot
    // pass vacuously: it proves the ack really crossed the wire and really was processed.
    // Without this arm, a promise pending because nothing was delivered at all would look
    // identical to one correctly pending on a token mismatch.
    const supersededArrived = host.whenAck('nonce:1')
    port2.postMessage({ t: 'ack', token: 'nonce:1' })
    await expect(supersededArrived).resolves.toBe(true)
    // Real timer, not `vi.waitFor`: proving a promise STAYS pending is the one thing
    // `waitFor` cannot do (`tests/flush.ts:7-13`).
    const raced = await Promise.race([
      wanted,
      new Promise((r) => {
        setTimeout(() => {
          r('still-pending')
        }, 20)
      }),
    ])
    expect(raced).toBe('still-pending')
    host.destroy()
  })

  it('whenAck resolves for an ack that arrived before the call', async () => {
    const { port1, port2 } = new MessageChannel()
    const host = createRpc(port1)
    let probed = false
    host.on('probe', () => {
      probed = true
    })
    port2.postMessage({ t: 'ack', token: 'nonce:3' })
    // Port delivery is FIFO, so once `probe` — posted AFTER the ack — has been dispatched,
    // the ack is already processed. That waits past the registration window instead of
    // guessing at it, which is the whole point: `whenAck` must not depend on its caller
    // registering before the guest replies (#213 is what "probably, by adjacency" costs).
    port2.postMessage({ t: 'event', event: 'probe', payload: null })
    await vi.waitFor(() => {
      expect(probed).toBe(true)
    })
    await expect(host.whenAck('nonce:3')).resolves.toBe(true)
    host.destroy()
  })
})
