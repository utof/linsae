// @vitest-environment node
/**
 * Unit tests for the ephemeral canvas LOD dev store.
 * Node env: pure store logic, no DOM required.
 * @see src/renderer/src/canvas/dev-lod.ts
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getCanvasDevLod, setCanvasDevLod, subscribeCanvasDevLod } from './dev-lod'

// Reset the module-level store state between tests by patching back to defaults.
afterEach(() => {
  setCanvasDevLod({ forceTier: 'auto', unclampZoom: false, syntheticDots: false })
  vi.clearAllMocks()
})

describe('getCanvasDevLod / setCanvasDevLod', () => {
  it('returns the default state on first read', () => {
    const s = getCanvasDevLod()
    expect(s.forceTier).toBe('auto')
    expect(s.unclampZoom).toBe(false)
    expect(s.syntheticDots).toBe(false)
  })

  it('full patch: setting all three fields is reflected by getter', () => {
    setCanvasDevLod({ forceTier: 'dot', unclampZoom: true, syntheticDots: true })
    const s = getCanvasDevLod()
    expect(s.forceTier).toBe('dot')
    expect(s.unclampZoom).toBe(true)
    expect(s.syntheticDots).toBe(true)
  })

  it('partial patch: unmentioned keys are preserved', () => {
    setCanvasDevLod({ forceTier: 'card' })
    const s = getCanvasDevLod()
    expect(s.forceTier).toBe('card')
    expect(s.unclampZoom).toBe(false)
    expect(s.syntheticDots).toBe(false)
  })

  it('sequential partial patches accumulate correctly', () => {
    setCanvasDevLod({ unclampZoom: true })
    setCanvasDevLod({ syntheticDots: true })
    const s = getCanvasDevLod()
    expect(s.unclampZoom).toBe(true)
    expect(s.syntheticDots).toBe(true)
    expect(s.forceTier).toBe('auto')
  })
})

describe('subscribeCanvasDevLod subscriber notification', () => {
  it('subscriber is called when setCanvasDevLod fires', () => {
    const listener = vi.fn()
    const unsub = subscribeCanvasDevLod(listener)
    setCanvasDevLod({ forceTier: 'dot' })
    expect(listener).toHaveBeenCalledTimes(1)
    unsub()
  })

  it('subscriber is called for every set call', () => {
    const listener = vi.fn()
    const unsub = subscribeCanvasDevLod(listener)
    setCanvasDevLod({ forceTier: 'card' })
    setCanvasDevLod({ unclampZoom: true })
    expect(listener).toHaveBeenCalledTimes(2)
    unsub()
  })

  it('unsubscribed listener is no longer called', () => {
    const listener = vi.fn()
    const unsub = subscribeCanvasDevLod(listener)
    setCanvasDevLod({ forceTier: 'dot' })
    expect(listener).toHaveBeenCalledTimes(1)
    unsub()
    setCanvasDevLod({ forceTier: 'card' })
    expect(listener).toHaveBeenCalledTimes(1) // no new call after unsub
  })

  it('getter reflects the new state by the time the subscriber fires', () => {
    let capturedState = getCanvasDevLod()
    const unsub = subscribeCanvasDevLod(() => {
      capturedState = getCanvasDevLod()
    })
    setCanvasDevLod({ forceTier: 'dot' })
    expect(capturedState.forceTier).toBe('dot')
    unsub()
  })
})
