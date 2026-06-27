/**
 * Center-to-center edge segment clipped at card bounds (spec §11).
 * @see docs/specs/v0.4-canvas-mvp.md §11
 */
import { describe, expect, it } from 'vitest'
import type { CanvasEdge } from '../../../shared/canvas'
import {
  arrowhead,
  borderPointToward,
  edgeSegment,
  nearestDrawnEdge,
  pointToSegmentDistance,
} from './edge-geometry'
import type { WorldRect } from './spatial-index'

const rect = (x: number, y: number) => ({ x, y, w: 100, h: 100 })

describe('borderPointToward', () => {
  // rect(0,0): center (50,50), borders x∈[0,100], y∈[0,100].
  it('exits the right border toward a point to the right', () => {
    expect(borderPointToward(rect(0, 0), { x: 200, y: 50 })).toEqual({ x: 100, y: 50 })
  })
  it('exits the bottom border toward a point below', () => {
    expect(borderPointToward(rect(0, 0), { x: 50, y: 200 })).toEqual({ x: 50, y: 100 })
  })
  it('exits the corner toward a 45° point', () => {
    expect(borderPointToward(rect(0, 0), { x: 150, y: 150 })).toEqual({ x: 100, y: 100 })
  })
  it('returns the center for a degenerate (center) target', () => {
    expect(borderPointToward(rect(0, 0), { x: 50, y: 50 })).toEqual({ x: 50, y: 50 })
  })
})

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

describe('nearestDrawnEdge', () => {
  // Two cards 300px apart on the x-axis (each 100×100, centers (50,50) & (350,50)).
  // edgeSegment clips at the card borders → the visible drawn segment is x∈[100,300]
  // at y=50. Edge midpoint ≈ (200, 50) — a point that sits BETWEEN the cards, i.e.
  // visually-empty (the normal edge hit, spec §5).
  const rects: ReadonlyMap<string, WorldRect> = new Map([
    ['a', rect(0, 0)],
    ['b', rect(300, 0)],
    // 'c' placed below 'a' for the second-drawn-edge "nearest wins" case.
    ['c', rect(0, 300)],
  ])
  const edge = (fromNoteId: string, toNoteId: string, edgeType: string): CanvasEdge => ({
    fromNoteId,
    toNoteId,
    toSlug: toNoteId, // slug == id in these fixtures; not used by the hit-test
    edgeType,
  })

  it('hits a DRAWN edge whose segment is within threshold', () => {
    const edges = [edge('a', 'b', 'link')]
    const hit = nearestDrawnEdge({ x: 200, y: 52 }, edges, rects, 6)
    expect(hit).not.toBeNull()
    expect(hit?.fromNoteId).toBe('a')
    expect(hit?.toSlug).toBe('b')
    expect(hit?.edgeType).toBe('link')
  })

  it('does NOT hit a reference/comment edge at the same point (drawn-only, decision 6)', () => {
    expect(nearestDrawnEdge({ x: 200, y: 52 }, [edge('a', 'b', 'reference')], rects, 6)).toBeNull()
    expect(nearestDrawnEdge({ x: 200, y: 52 }, [edge('a', 'b', 'comment-on')], rects, 6)).toBeNull()
  })

  it('returns null for an empty point (no drawn edge within threshold)', () => {
    const edges = [edge('a', 'b', 'link')]
    // (200, 400) is far from the y=50 segment → outside the 6px threshold.
    expect(nearestDrawnEdge({ x: 200, y: 400 }, edges, rects, 6)).toBeNull()
  })

  it('returns the NEAREST of two drawn edges', () => {
    // a→b is the horizontal segment at y=50; a→c is the vertical segment at x=50.
    // A point near the vertical (a→c) segment must select a→c, not a→b.
    const edges = [edge('a', 'b', 'link'), edge('a', 'c', 'supports')]
    const hit = nearestDrawnEdge({ x: 52, y: 200 }, edges, rects, 6)
    expect(hit?.toSlug).toBe('c')
    expect(hit?.edgeType).toBe('supports')
  })

  it('skips a drawn edge with an unplaced endpoint', () => {
    // 'ghost' is not in the rect map → the edge is skipped (dangling).
    const edges = [edge('a', 'ghost', 'link')]
    expect(nearestDrawnEdge({ x: 200, y: 52 }, edges, rects, 6)).toBeNull()
  })
})
