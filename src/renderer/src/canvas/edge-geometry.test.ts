/**
 * Center-to-center edge segment clipped at card bounds (spec §11).
 * @see docs/specs/v0.4-canvas-mvp.md §11
 */
import { describe, expect, it } from 'vitest'
import { arrowhead, edgeSegment, pointToSegmentDistance } from './edge-geometry'

const rect = (x: number, y: number) => ({ x, y, w: 100, h: 100 })

describe('edgeSegment', () => {
  it('clips both endpoints to the card borders', () => {
    const seg = edgeSegment(rect(0, 0), rect(300, 0))
    expect(seg).not.toBeNull()
    // centers (50,50) and (350,50); clipped at x=100 and x=300
    expect(seg).toEqual({ x1: 100, y1: 50, x2: 300, y2: 50 })
  })
  it('returns null for self/overlapping cards (zero-length after clip)', () => {
    expect(edgeSegment(rect(0, 0), rect(0, 0))).toBeNull()
    expect(edgeSegment(rect(0, 0), rect(10, 10))).toBeNull() // centers inside each other
  })
  it('handles diagonal placement', () => {
    const seg = edgeSegment(rect(0, 0), rect(200, 200))
    expect(seg).not.toBeNull()
    // 45° line from (50,50)→(250,250): exits first rect at (100,100), enters second at (200,200)
    expect(seg).toEqual({ x1: 100, y1: 100, x2: 200, y2: 200 })
  })
})

describe('pointToSegmentDistance', () => {
  const seg = { x1: 0, y1: 0, x2: 10, y2: 0 }
  it('0 on the segment', () => expect(pointToSegmentDistance({ x: 5, y: 0 }, seg)).toBe(0))
  it('perpendicular distance', () =>
    expect(pointToSegmentDistance({ x: 5, y: 3 }, seg)).toBeCloseTo(3))
  it('clamps past an endpoint', () =>
    expect(pointToSegmentDistance({ x: -4, y: 0 }, seg)).toBeCloseTo(4))
  it('degenerate segment = distance to the point', () =>
    expect(pointToSegmentDistance({ x: 3, y: 4 }, { x1: 0, y1: 0, x2: 0, y2: 0 })).toBeCloseTo(5))
})

describe('arrowhead', () => {
  it('returns two barb points behind the tip, symmetric about the segment', () => {
    const a = arrowhead({ x1: 0, y1: 0, x2: 10, y2: 0 }, 4) // size in world px
    // tip at (10,0); barbs behind it, mirrored across y=0
    expect(a.tip).toEqual({ x: 10, y: 0 })
    expect(a.left.x).toBeLessThan(10)
    expect(a.right.x).toBeLessThan(10)
    expect(a.left.y).toBeCloseTo(-a.right.y)
  })
  it('keeps barbs symmetric about a non-axis-aligned segment', () => {
    // 45° segment (0,0)→(10,10): barbs mirror across the line y=x, so left and
    // right swap coordinates. This constrains the perpendicular math that the
    // horizontal case leaves under-determined (uy=0 hides ux/uy sign errors).
    const a = arrowhead({ x1: 0, y1: 0, x2: 10, y2: 10 }, 4)
    expect(a.tip).toEqual({ x: 10, y: 10 })
    expect(a.left.x).toBeCloseTo(a.right.y)
    expect(a.left.y).toBeCloseTo(a.right.x)
    expect(a.left.x).toBeLessThan(10)
    expect(a.left.y).toBeLessThan(10)
  })
})
