/**
 * Unit tests for ink/coords.ts — client-space to image-space coordinate mapping.
 * Runs in happy-dom (provides getScreenCTM / DOMMatrix / DOMPoint).
 * @see src/renderer/src/ink/coords.ts
 * @see docs/specs/v0.2.5-screenshot-annotation.md §"Coordinate mapping"
 */
import { describe, expect, it, vi } from 'vitest'
import { clientToImagePoint } from './coords'

// ---------------------------------------------------------------------------
// Helper: build a minimal fake SVGSVGElement with a stubbed getScreenCTM
// ---------------------------------------------------------------------------

function makeFakeSvg(matrix: DOMMatrix): SVGSVGElement {
  return {
    getScreenCTM: vi.fn(() => matrix),
  } as unknown as SVGSVGElement
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('clientToImagePoint', () => {
  it('returns identity-mapped coordinates when CTM is identity', () => {
    // Identity matrix: a=1 b=0 c=0 d=1 e=0 f=0
    const identity = new DOMMatrix([1, 0, 0, 1, 0, 0])
    const svg = makeFakeSvg(identity)

    const result = clientToImagePoint(svg, 100, 200)
    expect(result.x).toBeCloseTo(100, 5)
    expect(result.y).toBeCloseTo(200, 5)
  })

  it('applies scale inverse when CTM has a uniform scale', () => {
    // CTM with scale=2 (each client pixel = 2 image pixels, so inverse halves coords)
    const scale2 = new DOMMatrix([2, 0, 0, 2, 0, 0])
    const svg = makeFakeSvg(scale2)

    const result = clientToImagePoint(svg, 100, 200)
    expect(result.x).toBeCloseTo(50, 5)
    expect(result.y).toBeCloseTo(100, 5)
  })

  it('applies scale+translate inverse correctly', () => {
    // CTM: scale=2, translate=(100, 50)
    // Client point (200, 150) → image point = (200-100)/2=50, (150-50)/2=50
    const ctm = new DOMMatrix([2, 0, 0, 2, 100, 50])
    const svg = makeFakeSvg(ctm)

    const result = clientToImagePoint(svg, 200, 150)
    expect(result.x).toBeCloseTo(50, 5)
    expect(result.y).toBeCloseTo(50, 5)
  })

  it('handles non-square scale (different x/y scale)', () => {
    // CTM: x scale=4, y scale=2, no translate
    const ctm = new DOMMatrix([4, 0, 0, 2, 0, 0])
    const svg = makeFakeSvg(ctm)

    const result = clientToImagePoint(svg, 80, 60)
    expect(result.x).toBeCloseTo(20, 5)
    expect(result.y).toBeCloseTo(30, 5)
  })

  it('handles translate-only CTM', () => {
    // CTM: no scale, translate=(30, 40)
    const ctm = new DOMMatrix([1, 0, 0, 1, 30, 40])
    const svg = makeFakeSvg(ctm)

    const result = clientToImagePoint(svg, 130, 140)
    expect(result.x).toBeCloseTo(100, 5)
    expect(result.y).toBeCloseTo(100, 5)
  })
})
