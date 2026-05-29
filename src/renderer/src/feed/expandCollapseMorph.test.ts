import { describe, expect, it } from 'vitest'
import { bottomAnchorScrollTop, cubicBezier, easeMorph, lerp } from './expandCollapseMorph'

describe('lerp', () => {
  it('interpolates endpoints and midpoint', () => {
    expect(lerp(0, 10, 0)).toBe(0)
    expect(lerp(0, 10, 1)).toBe(10)
    expect(lerp(0, 10, 0.5)).toBe(5)
  })
})

describe('cubicBezier / easeMorph', () => {
  it('pins the endpoints', () => {
    expect(easeMorph(0)).toBe(0)
    expect(easeMorph(1)).toBe(1)
    expect(cubicBezier(0.35, 0, 0.2, 1)(0)).toBe(0)
    expect(cubicBezier(0.35, 0, 0.2, 1)(1)).toBe(1)
  })

  it('is monotonic and stays within [0,1] (no overshoot)', () => {
    let prev = -1
    for (let i = 0; i <= 20; i++) {
      const y = easeMorph(i / 20)
      expect(y).toBeGreaterThanOrEqual(0)
      expect(y).toBeLessThanOrEqual(1)
      expect(y).toBeGreaterThanOrEqual(prev) // non-decreasing
      prev = y
    }
  })

  it('linear control points reduce to the identity (sanity check the solver)', () => {
    const linear = cubicBezier(1 / 3, 1 / 3, 2 / 3, 2 / 3)
    expect(linear(0.25)).toBeCloseTo(0.25, 4)
    expect(linear(0.5)).toBeCloseTo(0.5, 4)
    expect(linear(0.8)).toBeCloseTo(0.8, 4)
  })

  it('eases out: past the midpoint of progress it is past the midpoint of value', () => {
    // strong ease-out ⇒ y(0.5) > 0.5 (most of the distance covered early-mid)
    expect(easeMorph(0.5)).toBeGreaterThan(0.5)
  })
})

describe('bottomAnchorScrollTop', () => {
  it('keeps the bottom edge invariant: scrollTop is unchanged at the start height', () => {
    const noteStart = 2000
    const startH = 800
    const scrollTopStart = 1500
    const bottomScreenOffset = noteStart + startH - scrollTopStart // 1300
    expect(bottomAnchorScrollTop(noteStart, startH, bottomScreenOffset)).toBe(scrollTopStart)
  })

  it('scrolls up by exactly the height delta as the note shrinks', () => {
    const noteStart = 2000
    const bottomScreenOffset = 1300
    expect(bottomAnchorScrollTop(noteStart, 200, bottomScreenOffset)).toBe(900)
  })
})
