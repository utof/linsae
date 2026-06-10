/**
 * Unit tests for the devOverlays store.
 *
 * Runs in happy-dom (provides localStorage). Do NOT pin the node vitest environment —
 * localStorage is unavailable there and all persist round-trips would only hit the
 * fallback path.
 * @see src/renderer/src/dev/devOverlays.ts
 * @see docs/specs/v0.2.4-dev-tools-hud.md
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getOverlay, setOverlay, toggleOverlay } from './devOverlays'

// Reset both module state and localStorage before each test using the PUBLIC API only.
// (ephemeral record is module-private — do not reach in.)
beforeEach(() => {
  localStorage.clear()
  // Reset session-ephemeral state via public API
  setOverlay('reveal', false)
})

describe('getOverlay defaults (nothing stored)', () => {
  it('fps defaults to true', () => {
    expect(getOverlay('fps')).toBe(true)
  })

  it('boot defaults to false', () => {
    expect(getOverlay('boot')).toBe(false)
  })

  it('wave defaults to false', () => {
    expect(getOverlay('wave')).toBe(false)
  })

  it('reveal defaults to false', () => {
    expect(getOverlay('reveal')).toBe(false)
  })
})

describe('setOverlay persisted keys', () => {
  it('setOverlay("boot", true) → getOverlay("boot") true AND localStorage "devbootmeter" === "1"', () => {
    setOverlay('boot', true)
    expect(getOverlay('boot')).toBe(true)
    expect(localStorage.getItem('devbootmeter')).toBe('1')
  })

  it('setOverlay("boot", false) → getOverlay("boot") false AND stored "0"', () => {
    setOverlay('boot', true)
    setOverlay('boot', false)
    expect(getOverlay('boot')).toBe(false)
    expect(localStorage.getItem('devbootmeter')).toBe('0')
  })

  it('setOverlay("fps", true) persists to "devfpsmeter"', () => {
    setOverlay('fps', true)
    expect(localStorage.getItem('devfpsmeter')).toBe('1')
  })
})

describe('toggleOverlay', () => {
  it('toggleOverlay("wave") flips from false to true and persists to localStorage.wavetuner', () => {
    // wave defaults false
    toggleOverlay('wave')
    expect(getOverlay('wave')).toBe(true)
    expect(localStorage.getItem('wavetuner')).toBe('1')
  })

  it('toggleOverlay("wave") flips back to false', () => {
    toggleOverlay('wave')
    toggleOverlay('wave')
    expect(getOverlay('wave')).toBe(false)
    expect(localStorage.getItem('wavetuner')).toBe('0')
  })
})

describe('backward-compat reads', () => {
  it('"1" stored → getOverlay("wave") true', () => {
    localStorage.setItem('wavetuner', '1')
    expect(getOverlay('wave')).toBe(true)
  })

  it('"true" stored → getOverlay("wave") true (non-"0"/non-"" is truthy)', () => {
    localStorage.setItem('wavetuner', 'true')
    expect(getOverlay('wave')).toBe(true)
  })

  it('"0" stored → getOverlay("wave") false', () => {
    localStorage.setItem('wavetuner', '0')
    expect(getOverlay('wave')).toBe(false)
  })

  it('"" stored → getOverlay("wave") false', () => {
    localStorage.setItem('wavetuner', '')
    expect(getOverlay('wave')).toBe(false)
  })
})

describe('reveal is ephemeral (no localStorage)', () => {
  it('setOverlay("reveal", true) → getOverlay("reveal") true', () => {
    setOverlay('reveal', true)
    expect(getOverlay('reveal')).toBe(true)
  })

  it('NO localStorage key is written for reveal', () => {
    localStorage.clear()
    setOverlay('reveal', true)
    expect(localStorage.length).toBe(0)
  })
})

describe('localStorage throw safety', () => {
  it('setOverlay("boot", true) does NOT throw when localStorage.setItem throws', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError')
    })
    expect(() => setOverlay('boot', true)).not.toThrow()
    vi.restoreAllMocks()
  })

  it('getOverlay("boot") returns the default (false) when localStorage.getItem throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError')
    })
    expect(getOverlay('boot')).toBe(false)
    vi.restoreAllMocks()
  })
})
