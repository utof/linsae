// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'

// Mock Vidstack's vanilla constructor. `create` is async (returns Promise<player>),
// so the singleton bridges it through `ready()`. Each call yields a fresh fake whose
// `currentTime` setter feeds `state.currentTime` (mirrors the real seek→state flow),
// and whose `subscribe` returns a tracked unsubscribe fn (the sister-token contract
// the old youtube-player engine had is gone — Vidstack returns the disposer directly).
const { createMock, subscribeMock, unsubscribeMock } = vi.hoisted(() => {
  const unsubscribeMock = vi.fn()
  const subscribeMock = vi.fn((cb: (s: unknown) => void) => {
    ;(subscribeMock as unknown as { lastCb?: (s: unknown) => void }).lastCb = cb
    return unsubscribeMock
  })
  const createMock = vi.fn(() => {
    let ct = 0
    const fake = {
      get currentTime() {
        return ct
      },
      set currentTime(v: number) {
        ct = v
      },
      playbackRate: 1,
      src: '' as unknown,
      state: {
        get currentTime() {
          return ct
        },
        duration: 0,
      },
      play: vi.fn().mockResolvedValue(undefined),
      pause: vi.fn().mockResolvedValue(undefined),
      subscribe: subscribeMock,
      destroy: vi.fn(),
    }
    return Promise.resolve(fake)
  })
  return { createMock, subscribeMock, unsubscribeMock }
})

vi.mock('vidstack/global/player', () => ({
  VidstackPlayer: { create: createMock },
}))

import { destroyPlayer, getPlayer } from './playerSingleton'

afterEach(() => {
  destroyPlayer()
  vi.clearAllMocks()
})

describe('playerSingleton', () => {
  it('constructs the underlying player exactly once across getPlayer calls', () => {
    const a = getPlayer()
    const b = getPlayer()
    expect(a).toBe(b)
    expect(createMock).toHaveBeenCalledTimes(1)
  })

  it('passes the wrapper element as the create target (selector would not resolve while detached)', () => {
    const p = getPlayer()
    expect(createMock).toHaveBeenCalledWith(expect.objectContaining({ target: p.wrapper }))
  })

  it('seekTo sets currentTime and getCurrentTime reads it back from state', async () => {
    const p = getPlayer()
    await p.seekTo(42)
    expect(await p.getCurrentTime()).toBe(42)
  })

  it('load() maps a bare id to the youtube/<id> shorthand and passes a URL through', async () => {
    const p = getPlayer()
    await p.load('dQw4w9WgXcQ')
    expect(p.videoId).toBe('dQw4w9WgXcQ')
  })

  it('onStateChange subscribes, forwards the derived state, and the disposer unsubscribes', async () => {
    const p = getPlayer()
    const cb = vi.fn()
    const unsub = p.onStateChange(cb)
    // subscribe is wired after the async create resolves.
    await vi.waitFor(() => expect(subscribeMock).toHaveBeenCalledTimes(1))

    const drive = (subscribeMock as unknown as { lastCb: (s: unknown) => void }).lastCb
    drive({ playing: true })
    expect(cb).toHaveBeenCalledWith('playing')
    // Dedupe: an identical state must not re-fire.
    drive({ playing: true })
    expect(cb).toHaveBeenCalledTimes(1)

    expect(unsubscribeMock).not.toHaveBeenCalled()
    unsub()
    expect(unsubscribeMock).toHaveBeenCalledTimes(1)
  })

  it('reconstructs a fresh player after destroyPlayer()', () => {
    getPlayer()
    destroyPlayer()
    getPlayer()
    expect(createMock).toHaveBeenCalledTimes(2)
  })
})
