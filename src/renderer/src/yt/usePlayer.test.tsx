// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const fakeWrapper = document.createElement('div')
const onState = vi.fn(() => () => {})
vi.mock('./playerSingleton', () => ({
  getPlayer: () => ({
    wrapper: fakeWrapper,
    videoId: 'v',
    load: vi.fn().mockResolvedValue(undefined),
    play: vi.fn(),
    pause: vi.fn(),
    seekTo: vi.fn().mockResolvedValue(undefined),
    getCurrentTime: vi.fn().mockResolvedValue(12),
    getDuration: vi.fn().mockResolvedValue(100),
    setPlaybackRate: vi.fn(),
    onStateChange: onState,
    getIframeRect: () => null,
    destroy: vi.fn(),
  }),
  destroyPlayer: vi.fn(),
}))

import { usePlayer } from './usePlayer'

afterEach(() => vi.clearAllMocks())

describe('usePlayer', () => {
  it('loads the videoId and re-parents the wrapper into the host element', () => {
    const host = document.createElement('div')
    renderHook(() => usePlayer('v', { current: host }))
    expect(host.contains(fakeWrapper)).toBe(true)
  })
  it('subscribes to state changes', () => {
    renderHook(() => usePlayer('v', { current: document.createElement('div') }))
    expect(onState).toHaveBeenCalled()
  })
})
