// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { AnchorItem } from './page-anchor'
import { anchorFromOffset, offsetFromAnchor } from './page-anchor'

// A page starting at 40000px, 2000px tall — big enough to hold several
// non-round offsets comfortably interior to the page.
const ITEM: AnchorItem = { index: 20, start: 40000, size: 2000 }

describe('page-anchor', () => {
  it('anchorFromOffset at fraction 0.5 returns {page, fraction: 0.5}', () => {
    const anchor = anchorFromOffset(41000, ITEM) // 40000 + 0.5 * 2000
    expect(anchor).toEqual({ page: 21, fraction: 0.5 })
  })

  it('offsetFromAnchor at fraction 0.5 returns the corresponding offset (reverse of the above)', () => {
    expect(offsetFromAnchor(0.5, ITEM)).toBe(41000)
  })

  it('round-trips at a non-round offset', () => {
    // 40777 is interior to [40000, 42000); assert exact equality — both directions
    // are plain multiply/divide with no intermediate flooring, so no FP slop.
    const anchor = anchorFromOffset(40777, ITEM)
    expect(offsetFromAnchor(anchor.fraction, ITEM)).toBe(40777)
  })

  it('clamps above: an offset past the page end yields fraction 1', () => {
    expect(anchorFromOffset(50000, ITEM).fraction).toBe(1)
  })

  it('clamps below: an offset before the page start yields fraction 0', () => {
    expect(anchorFromOffset(0, ITEM).fraction).toBe(0)
  })

  it('handles a zero-size item without NaN, and clamps stored out-of-range fractions', () => {
    const zeroItem: AnchorItem = { index: 0, start: 0, size: 0 }
    expect(anchorFromOffset(12345, zeroItem)).toEqual({ page: 1, fraction: 0 })
    // A corrupted persisted fraction must clamp to the page's edges, not extrapolate past them.
    expect(offsetFromAnchor(1.7, ITEM)).toBe(ITEM.start + ITEM.size)
    expect(offsetFromAnchor(-3, ITEM)).toBe(ITEM.start)
  })
})
