// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { clientRectsToPdfRect } from './clientRectsToPdfRect'
import { pdfRectToCssBox } from './pdfRectToCssBox'

/**
 * Stub with the real rotation-0 viewport transform `[scale, 0, 0, -scale, 0, height]`
 * (pdf.js sets `rotateD = -1` for rotation 0 — `build/pdf.mjs:838-841`), exposing BOTH
 * directions so the capture→flash round-trip can be asserted end to end.
 */
const makeViewport = (scale: number, height: number) => ({
  // applyTransform: [a*x + c*y + e, b*x + d*y + f]
  convertToViewportPoint: (x: number, y: number): [number, number] => [
    scale * x,
    height - scale * y,
  ],
  // applyInverseTransform: [(x - e)/a, (y - f)/d]
  convertToPdfPoint: (x: number, y: number): [number, number] => [x / scale, (height - y) / scale],
})

describe('pdfRectToCssBox', () => {
  it('maps the rect TOP (y + h) to the CSS top-left — PDF user space is y-up', () => {
    // clientRectsToPdfRect returns [minX, minY, w, h] with minY the VISUAL BOTTOM
    // (PageViewport sets rotateD = -1 for rotation 0; clientRectsToPdfRect.ts:22-27).
    // Mapping (x, y) instead of (x, y+h) places the flash one rect-height too low.
    const vp = {
      convertToViewportPoint: (x: number, y: number) => [x, 800 - y] as [number, number],
    }
    expect(pdfRectToCssBox(vp, [100, 200, 50, 20]).top).toBe(800 - 220)
  })

  it('places the box left at the rect x and keeps width/height positive', () => {
    const vp = makeViewport(1, 800)
    expect(pdfRectToCssBox(vp, [100, 200, 50, 20])).toEqual({
      left: 100,
      top: 580,
      width: 50,
      height: 20,
    })
  })

  it('round-trips a client rect: capture → PDF space → CSS box returns the same box', () => {
    // The strongest guarantee: the flash overlay must land exactly where the user
    // dragged. Anything but a true inverse of clientRectsToPdfRect breaks this.
    const vp = makeViewport(1, 800)
    const pageRect = { left: 0, top: 0 }
    const clientRects = [{ left: 100, top: 100, right: 150, bottom: 120 }]
    const pdfRect = clientRectsToPdfRect(vp, pageRect, clientRects)
    expect(pdfRectToCssBox(vp, pdfRect)).toEqual({ left: 100, top: 100, width: 50, height: 20 })
  })

  it('scales with the viewport: the same rect at 2× zoom is twice the box at 1×', () => {
    const at1 = pdfRectToCssBox(makeViewport(1, 800), [100, 200, 50, 20])
    const at2 = pdfRectToCssBox(makeViewport(2, 1600), [100, 200, 50, 20])
    expect(at2.left).toBeCloseTo(at1.left * 2)
    expect(at2.top).toBeCloseTo(at1.top * 2)
    expect(at2.width).toBeCloseTo(at1.width * 2)
    expect(at2.height).toBeCloseTo(at1.height * 2)
  })

  it('stays a valid box under 90° rotation, where the two corners convert out of order', () => {
    // rotation 90 → rotateA=0, rotateB=1, rotateC=1, rotateD=0 (build/pdf.mjs:825-830),
    // i.e. viewport = [y, x]. The visual-top-left corner then converts to the LARGER
    // viewport x, so a Math.min-less implementation reports left=220 and width=-20.
    const vp = { convertToViewportPoint: (x: number, y: number) => [y, x] as [number, number] }
    expect(pdfRectToCssBox(vp, [100, 200, 50, 20])).toEqual({
      left: 200,
      top: 100,
      width: 20, // the PDF-space height, since 90° swaps the axes
      height: 50,
    })
  })

  it('reports zero area for the degenerate [0,0,0,0] rect (the no-flash signal)', () => {
    // clientRectsToPdfRect.ts:16 returns [0,0,0,0] for an empty rect list and capture
    // stores it unconditionally (useExcerptCapture.ts:79-84); the drain uses zero area
    // to scroll without flashing (spec §5.3).
    const box = pdfRectToCssBox(makeViewport(1, 800), [0, 0, 0, 0])
    expect(box.width).toBe(0)
    expect(box.height).toBe(0)
  })
})
