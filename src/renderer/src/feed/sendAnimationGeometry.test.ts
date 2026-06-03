// @vitest-environment node
/**
 * Unit tests for sendAnimationGeometry.ts — pure geometry, no DOM.
 *
 * @see docs/specs/v0.2.1-send-animation.md
 */
import { describe, expect, it } from 'vitest'
import { SEND_EASE, sendFrame, sendTarget } from './sendAnimationGeometry'

describe('SEND_EASE (spring-overshoot cubic-bezier)', () => {
  it('returns 0 at t=0', () => {
    expect(SEND_EASE(0)).toBe(0)
  })

  it('returns 1 at t=1', () => {
    expect(SEND_EASE(1)).toBeCloseTo(1, 3)
  })

  it('overshoots above 1.0 at some t in (0.5, 1)', () => {
    // cubic-bezier(0.34, 1.56, 0.64, 1) — y2=1.56 guarantees overshoot
    let didOvershoot = false
    for (let i = 51; i <= 99; i++) {
      if (SEND_EASE(i / 100) > 1.0) {
        didOvershoot = true
        break
      }
    }
    expect(didOvershoot).toBe(true)
  })
})

describe('sendTarget', () => {
  const base = {
    scrollerTop: 100,
    scrollerBottom: 700,
    scrollerHeight: 600,
    feedContentLeft: 24,
  }

  it('tall feed: new note top is pinned to scrollerBottom - noteH', () => {
    // contentHeight=2000 >> scrollerHeight=600 → bottom-pinned
    const result = sendTarget({ ...base, contentHeight: 2000, noteH: 50 })
    expect(result.top).toBe(650) // 700 - 50
    expect(result.left).toBe(24)
  })

  it('short feed: new note top is scrollerTop + contentHeight (content-relative append)', () => {
    // contentHeight=100, noteH=50 → 100+50=150 < 600, so content fits
    const result = sendTarget({ ...base, contentHeight: 100, noteH: 50 })
    expect(result.top).toBe(200) // 100 + 100
    expect(result.left).toBe(24)
  })

  it('boundary: both formulas agree when contentHeight + noteH === scrollerHeight', () => {
    // contentHeight=550, noteH=50 → 550+50=600 === scrollerHeight
    // short branch: scrollerTop + contentHeight = 100 + 550 = 650
    // tall branch:  scrollerBottom - noteH       = 700 - 50  = 650
    const result = sendTarget({ ...base, contentHeight: 550, noteH: 50 })
    expect(result.top).toBe(650)
  })

  it('passes left through unchanged', () => {
    const result = sendTarget({ ...base, contentHeight: 2000, noteH: 50 })
    expect(result.left).toBe(base.feedContentLeft)
  })
})

describe('sendFrame', () => {
  const start = { top: 300, left: 50 }
  const target = { top: 650, left: 24 }

  it('progress=0 → no translation, fully opaque', () => {
    const frame = sendFrame(0, start, target)
    expect(frame.tx).toBe(0)
    expect(frame.ty).toBe(0)
    expect(frame.opacity).toBe(1)
  })

  it('progress=1 → full translation, fully transparent', () => {
    const frame = sendFrame(1, start, target)
    // SEND_EASE(1)===1, so tx = (24-50)*1 = -26, ty = (650-300)*1 = 350
    expect(frame.tx).toBeCloseTo(-26, 2)
    expect(frame.ty).toBeCloseTo(350, 2)
    expect(frame.opacity).toBe(0)
  })

  it('progress=0.5 → opacity is 1 (fade not yet started)', () => {
    const frame = sendFrame(0.5, start, target)
    expect(frame.opacity).toBe(1)
  })

  it('progress=0.8 → opacity ≈ 0.5 (halfway through the 0.6→1.0 fade window)', () => {
    // opacity = 1 - (0.8 - 0.6) / 0.4 = 1 - 0.5 = 0.5
    const frame = sendFrame(0.8, start, target)
    expect(frame.opacity).toBeCloseTo(0.5, 6)
  })

  it('opacity uses raw progress, not eased (progress=0.6 is the exact fade-start)', () => {
    const frame = sendFrame(0.6, start, target)
    // 0.6 is the boundary — 0.6 < 0.6 is false → opacity = 1 - (0.6-0.6)/0.4 = 1
    expect(frame.opacity).toBeCloseTo(1, 6)
  })
})
