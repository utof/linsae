import { describe, expect, it } from 'vitest'
import { bottomAnchorScrollTop, easeOutCubic, lerp } from './expandCollapseMorph'

describe('lerp', () => {
  it('interpolates endpoints and midpoint', () => {
    expect(lerp(0, 10, 0)).toBe(0)
    expect(lerp(0, 10, 1)).toBe(10)
    expect(lerp(0, 10, 0.5)).toBe(5)
  })
})

describe('easeOutCubic', () => {
  it('pins 0 and 1 and eases past the midpoint', () => {
    expect(easeOutCubic(0)).toBe(0)
    expect(easeOutCubic(1)).toBe(1)
    expect(easeOutCubic(0.5)).toBeCloseTo(0.875, 5)
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
