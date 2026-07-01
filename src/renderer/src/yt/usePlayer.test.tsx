// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

// ISOLATION: isolate:false shares the module cache. PlayerPane.test.tsx (which
// runs earlier alphabetically) imports ./usePlayer → playerSingleton, caching
// usePlayer.ts with PlayerPane's mock bindings. Clearing the module cache HERE
// (in vi.hoisted — which runs before imports, even before vi.mock) forces
// usePlayer.ts to be freshly imported against THIS file's mock of playerSingleton.
// vi.mock registrations from earlier files survive vi.resetModules() (they are in
// the mock registry, not the module cache), so the override below re-applies. (ADR 0014)
vi.hoisted(() => vi.resetModules())

const fakeWrapper = document.createElement('div')
const onState = vi.fn(() => () => {})
const mount = vi.fn()
const unmount = vi.fn()
vi.mock('./playerSingleton', () => ({
  getPlayer: () => ({
    wrapper: fakeWrapper,
    videoId: 'v',
    mount,
    unmount,
    load: vi.fn().mockResolvedValue(undefined),
    play: vi.fn(),
    pause: vi.fn(),
    seekTo: vi.fn().mockResolvedValue(undefined),
    getCurrentTime: vi.fn().mockResolvedValue(12),
    getDuration: vi.fn().mockResolvedValue(100),
    setPlaybackRate: vi.fn(),
    onStateChange: onState,
    getMediaRect: () => null,
    destroy: vi.fn(),
  }),
  destroyPlayer: vi.fn(),
}))

import { usePlayer } from './usePlayer'

afterEach(() => vi.clearAllMocks())

describe('usePlayer', () => {
  it('mounts the player onto the host element (positions it; no DOM re-parenting)', () => {
    const host = document.createElement('div')
    renderHook(() => usePlayer('v', { current: host }))
    expect(mount).toHaveBeenCalledWith(host)
  })
  it('unmounts (parks the player) on cleanup', () => {
    const { unmount: unmountHook } = renderHook(() =>
      usePlayer('v', { current: document.createElement('div') }),
    )
    unmountHook()
    expect(unmount).toHaveBeenCalled()
  })
  it('subscribes to state changes', () => {
    renderHook(() => usePlayer('v', { current: document.createElement('div') }))
    expect(onState).toHaveBeenCalled()
  })
})
