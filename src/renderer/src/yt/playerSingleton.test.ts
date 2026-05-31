// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'

// `on` returns a sister listener token that `off` must receive verbatim (the
// real youtube-player/sister contract — see playerSingleton's onStateChange).
const { ctor, onMock, offMock, LISTENER } = vi.hoisted(() => {
  const LISTENER = { token: 'stateChange-listener' }
  return { ctor: vi.fn(), onMock: vi.fn(() => LISTENER), offMock: vi.fn(), LISTENER }
})

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
      on: onMock,
      off: offMock,
      getIframe: vi.fn().mockResolvedValue(document.createElement('iframe')),
      destroy: vi.fn().mockResolvedValue(undefined),
    }
  },
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
    expect(ctor).toHaveBeenCalledTimes(1)
  })
  it('delegates seekTo/getCurrentTime to the wrapped player', async () => {
    const p = getPlayer()
    await p.seekTo(42)
    expect(await p.getCurrentTime()).toBe(0)
  })
  it('onStateChange subscribes via on() and the unsubscribe passes the listener token to off()', () => {
    const p = getPlayer()
    const unsub = p.onStateChange(() => {})
    expect(onMock).toHaveBeenCalledWith('stateChange', expect.any(Function))
    expect(offMock).not.toHaveBeenCalled()
    unsub()
    // off() must receive the value on() returned (a no-op if the handler fn were passed instead).
    expect(offMock).toHaveBeenCalledWith(LISTENER)
  })
  it('reconstructs a fresh player after destroyPlayer()', () => {
    getPlayer()
    destroyPlayer()
    getPlayer()
    expect(ctor).toHaveBeenCalledTimes(2)
  })
})
