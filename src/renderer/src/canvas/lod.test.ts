/**
 * Tier thresholds are load-bearing for the semantic-zoom milestone.
 * @see docs/specs/v0.4-canvas-mvp.md §12
 */
import { describe, expect, it } from 'vitest'
import { TIER_THRESHOLDS, tierForZoom } from './lod'

describe('tierForZoom', () => {
  it('maps zoom to tiers with thresholds exclusive on the lower side', () => {
    expect(tierForZoom(1)).toBe('card')
    expect(tierForZoom(0.5)).toBe('card') // floor of the user clamp stays card
    expect(tierForZoom(0.49)).toBe('title')
    expect(tierForZoom(0.15)).toBe('title')
    expect(tierForZoom(0.149)).toBe('dot')
    expect(tierForZoom(0.0001)).toBe('dot')
  })
  it('pins the threshold constants (spec §12)', () => {
    expect(TIER_THRESHOLDS).toEqual({ title: 0.5, dot: 0.15 })
  })
})
