// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { clientRectsToPdfRect } from './clientRectsToPdfRect'

// A stub viewport with a known transform [scale,0,0,-scale,0,height]
const makeViewport = (scale: number, height: number) => ({
  transform: [scale, 0, 0, -scale, 0, height] as [number, number, number, number, number, number],
  convertToPdfPoint: (x: number, y: number): [number, number] => {
    const [a, _b, _c, d, e, f] = [scale, 0, 0, -scale, 0, height]
    // pdf.js applyInverseTransform: x' = (x - e) / a; y' = (y - f) / d
    return [(x - e) / a, (y - f) / d]
  },
})

describe('clientRectsToPdfRect', () => {
  it('converts a single client rect to PDF user-space [x,y,w,h]', () => {
    const viewport = makeViewport(1, 800) // 1:1, page height 800
    const pageRect = { left: 0, top: 0, right: 600, bottom: 800, width: 600, height: 800 }
    // a client rect at screen (100,100) size (50,20)
    const clientRects = [{ left: 100, top: 100, right: 150, bottom: 120, width: 50, height: 20 }]
    const [x, y, w, h] = clientRectsToPdfRect(viewport as never, pageRect, clientRects as never)
    expect(w).toBeCloseTo(50)
    expect(h).toBeCloseTo(20)
    // PDF y is from bottom-left; screen y=100 → PDF y = 800 - 100 = 700 (top edge)
    expect(y).toBeCloseTo(680) // 800 - 100 - 20 (bottom-left of rect in PDF space)
    expect(x).toBeCloseTo(100)
  })

  it('is zoom-invariant: a 2× viewport maps to the same PDF rect (B18)', () => {
    // At zoom 2 the page renders 2× larger (height 1600) and the client rect is
    // 2× the pixels — but convertToPdfPoint divides by the same (zoomed) scale,
    // so the captured PDF-space rect is identical to the scale-1 case above.
    const viewport = makeViewport(2, 1600)
    const pageRect = { left: 0, top: 0, right: 1200, bottom: 1600, width: 1200, height: 1600 }
    const clientRects = [{ left: 200, top: 200, right: 300, bottom: 240, width: 100, height: 40 }]
    const [x, y, w, h] = clientRectsToPdfRect(viewport as never, pageRect, clientRects as never)
    expect(x).toBeCloseTo(100)
    expect(y).toBeCloseTo(680)
    expect(w).toBeCloseTo(50)
    expect(h).toBeCloseTo(20)
  })

  it('returns [0,0,0,0] for empty clientRects', () => {
    const viewport = makeViewport(1, 800)
    const pageRect = { left: 0, top: 0, right: 600, bottom: 800, width: 600, height: 800 }
    expect(clientRectsToPdfRect(viewport as never, pageRect, [])).toEqual([0, 0, 0, 0])
  })
})
