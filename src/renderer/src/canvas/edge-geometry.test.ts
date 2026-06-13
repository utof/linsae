/**
 * Center-to-center edge segment clipped at card bounds (spec §11).
 * @see docs/specs/v0.4-canvas-mvp.md §11
 */
import { describe, expect, it } from 'vitest'
import { edgeSegment } from './edge-geometry'

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
