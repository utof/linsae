// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'

const ctor = vi.fn()
vi.mock('youtube-player', () => ({
  default: (el: HTMLElement) => {
    ctor(el)
    return {
      loadVideoById: vi.fn().mockResolvedValue(undefined),
      seekTo: vi.fn().mockResolvedValue(undefined),
      getCurrentTime: vi.fn().mockResolvedValue(0),
      getDuration: vi.fn().mockResolvedValue(0),
      playVideo: vi.fn().mockResolvedValue(undefined),
      pauseVideo: vi.fn().mockResolvedValue(undefined),
      setPlaybackRate: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
      off: vi.fn(),
      getIframe: vi.fn().mockResolvedValue(document.createElement('iframe')),
      destroy: vi.fn().mockResolvedValue(undefined),
    }
  },
}))

import { destroyPlayer, getPlayer } from './playerSingleton'

afterEach(() => destroyPlayer())

describe('playerSingleton', () => {
  it('constructs the underlying player exactly once across getPlayer calls', () => {
    const a = getPlayer()
    const b = getPlayer()
    expect(a).toBe(b)
    expect(ctor).toHaveBeenCalledTimes(1)
  })
  it('delegates seekTo/getCurrentTime to the wrapped player', async () => {
    const p = getPlayer()
    await p.seekTo(42)
    expect(await p.getCurrentTime()).toBe(0)
  })
})
