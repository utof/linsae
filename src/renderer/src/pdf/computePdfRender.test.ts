// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { computePdfRender } from './computePdfRender'

// A typical US-Letter portrait page at scale 1: 612 × 792 PDF units.
const PAGE_W = 612
const PAGE_H = 792

describe('computePdfRender', () => {
  it('fits the page to the container width (cssW === containerWidth, no overflow)', () => {
    const { fitScale, cssW, cssH } = computePdfRender(816, PAGE_W, PAGE_H, 1)
    // 816 / 612 = 1.333… — the page is scaled UP to exactly fill the pane.
    expect(fitScale).toBeCloseTo(816 / 612)
    expect(cssW).toBeCloseTo(816) // never wider than the container ⇒ no h-overflow
    expect(cssH).toBeCloseTo(792 * (816 / 612)) // aspect ratio preserved
  })

  it('scales the backing store by dpr while keeping the CSS size fixed', () => {
    const dpr2 = computePdfRender(612, PAGE_W, PAGE_H, 2)
    const dpr1 = computePdfRender(612, PAGE_W, PAGE_H, 1)
    // CSS (display) size is identical regardless of dpr…
    expect(dpr2.cssW).toBeCloseTo(dpr1.cssW)
    expect(dpr2.cssH).toBeCloseTo(dpr1.cssH)
    // …but the bitmap (backing store) is 2× denser on a HiDPI display.
    expect(dpr2.bitmapW).toBe(1224)
    expect(dpr2.bitmapH).toBe(1584)
    expect(dpr1.bitmapW).toBe(612)
    expect(dpr1.bitmapH).toBe(792)
  })

  it('emits the [dpr,0,0,dpr,0,0] render transform on HiDPI', () => {
    expect(computePdfRender(612, PAGE_W, PAGE_H, 2).transform).toEqual([2, 0, 0, 2, 0, 0])
  })

  it('omits the transform (undefined) when dpr === 1', () => {
    expect(computePdfRender(612, PAGE_W, PAGE_H, 1).transform).toBeUndefined()
  })

  it('rounds the backing store for a fractional dpr', () => {
    const { bitmapW, bitmapH, transform } = computePdfRender(612, PAGE_W, PAGE_H, 1.5)
    expect(bitmapW).toBe(Math.round(612 * 1.5)) // 918
    expect(bitmapH).toBe(Math.round(792 * 1.5)) // 1188
    expect(transform).toEqual([1.5, 0, 0, 1.5, 0, 0])
  })

  it('fits a narrow container by scaling the page down (still no overflow)', () => {
    const { fitScale, cssW } = computePdfRender(306, PAGE_W, PAGE_H, 1)
    expect(fitScale).toBeCloseTo(0.5)
    expect(cssW).toBeCloseTo(306)
  })

  it('fits a wide container by scaling the page up to fill it', () => {
    const { fitScale, cssW } = computePdfRender(1224, PAGE_W, PAGE_H, 1)
    expect(fitScale).toBeCloseTo(2)
    expect(cssW).toBeCloseTo(1224)
  })
})
