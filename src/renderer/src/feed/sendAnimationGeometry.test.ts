// @vitest-environment node
/**
 * Unit tests for sendAnimationGeometry.ts — pure geometry, no DOM.
 *
 * @see docs/specs/v0.2.1-send-animation.md
 */
import { describe, expect, it } from 'vitest'
import { sendTarget } from './sendAnimationGeometry'

describe('sendTarget (bottom-anchored feed)', () => {
  it('new note top is always scrollerBottom - noteH', () => {
    const result = sendTarget({ scrollerBottom: 700, noteH: 50, feedContentLeft: 24 })
    expect(result.top).toBe(650) // 700 - 50
    expect(result.left).toBe(24)
  })

  it('taller note lands higher (top = bottom - its own height)', () => {
    const result = sendTarget({ scrollerBottom: 700, noteH: 120, feedContentLeft: 24 })
    expect(result.top).toBe(580) // 700 - 120
  })

  it('passes feedContentLeft through unchanged', () => {
    const result = sendTarget({ scrollerBottom: 700, noteH: 50, feedContentLeft: 24 })
    expect(result.left).toBe(24)
  })
})
