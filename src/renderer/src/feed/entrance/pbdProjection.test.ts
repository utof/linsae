// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { projectNoOverlap } from './pbdProjection'

describe('projectNoOverlap', () => {
  // offsets are ordered TOP→BOTTOM; the last (newcomer) is the pinned anchor and is never moved.
  it('leaves an already non-overlapping stack unchanged', () => {
    expect(projectNoOverlap([0, 0, 50], 8)).toEqual([0, 0, 50])
  })
  it('pushes ONLY the upper of an overlapping pair up; the anchor (last) stays put', () => {
    // upper offset 50 > lower offset 10 ⇒ they overlap (upper pushed down past lower).
    const out = projectNoOverlap([50, 10], 8)
    expect(out[1]).toBe(10) // anchor unchanged
    expect(out[0]).toBeLessThanOrEqual(10) // upper clamped up to (≤) the lower
  })
  it('propagates the shove upward across the stack', () => {
    const out = projectNoOverlap([90, 60, 30, 0], 8)
    for (let i = 1; i < out.length; i++)
      expect((out[i] as number) - (out[i - 1] as number)).toBeGreaterThanOrEqual(-1e-9)
    expect(out[out.length - 1]).toBe(0) // anchor pinned
  })
})
