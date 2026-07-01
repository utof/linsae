// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { clampZoom, computePdfRender, ZOOM_MAX, ZOOM_MIN } from './computePdfRender'

// A typical US-Letter portrait page at scale 1: 612 × 792 PDF units.
const PAGE_W = 612
const PAGE_H = 792

describe('computePdfRender', () => {
  it('fits the page to the container width without ever overflowing (B17)', () => {
    // 816 / 612 is not exact in float; flooring guarantees cssW ≤ container so a
    // sub-pixel remainder can never produce a horizontal scrollbar at fit.
    const { fitScale, cssW, cssH } = computePdfRender(816, PAGE_W, PAGE_H, 1)
    expect(fitScale).toBeCloseTo(816 / 612)
    expect(cssW).toBeLessThanOrEqual(816) // never wider than the container
    expect(cssW).toBeGreaterThanOrEqual(815) // …but fits snugly (within 1px)
    expect(cssH).toBeCloseTo(Math.floor(792 * (816 / 612)))
  })

  it('keeps cssW ≤ containerWidth across a width sweep at zoom 1 (B17)', () => {
    for (const w of [200, 333, 481, 600, 757, 900, 1024, 1337]) {
      expect(computePdfRender(w, PAGE_W, PAGE_H, 1).cssW).toBeLessThanOrEqual(w)
    }
  })

  it('treats a gutter-reduced container width as the fit width (no overflow)', () => {
    // The component passes clientWidth, which already subtracts the reserved
    // scrollbar-gutter — so a "post-gutter" width still fits with no overflow.
    expect(computePdfRender(600 - 15, PAGE_W, PAGE_H, 1).cssW).toBeLessThanOrEqual(600 - 15)
  })

  it('scales the backing store by dpr while keeping the CSS size fixed (B8)', () => {
    const dpr2 = computePdfRender(612, PAGE_W, PAGE_H, 2)
    const dpr1 = computePdfRender(612, PAGE_W, PAGE_H, 1)
    expect(dpr2.cssW).toBe(dpr1.cssW) // CSS display size is dpr-independent…
    expect(dpr2.cssH).toBe(dpr1.cssH)
    expect(dpr2.bitmapW).toBe(1224) // …but the bitmap is 2× denser on HiDPI
    expect(dpr2.bitmapH).toBe(1584)
    expect(dpr1.bitmapW).toBe(612)
    expect(dpr1.bitmapH).toBe(792)
  })

  it('emits the [dpr,0,0,dpr,0,0] render transform on HiDPI (B8)', () => {
    expect(computePdfRender(612, PAGE_W, PAGE_H, 2).transform).toEqual([2, 0, 0, 2, 0, 0])
  })

  it('omits the transform (undefined) when dpr === 1 (B8)', () => {
    expect(computePdfRender(612, PAGE_W, PAGE_H, 1).transform).toBeUndefined()
  })

  it('rounds the backing store for a fractional dpr (B8)', () => {
    const { bitmapW, bitmapH, transform } = computePdfRender(612, PAGE_W, PAGE_H, 1.5)
    expect(bitmapW).toBe(Math.round(612 * 1.5)) // 918
    expect(bitmapH).toBe(Math.round(792 * 1.5)) // 1188
    expect(transform).toEqual([1.5, 0, 0, 1.5, 0, 0])
  })

  it('fits a narrow / wide container by scaling the page down / up (B9)', () => {
    expect(computePdfRender(306, PAGE_W, PAGE_H, 1).fitScale).toBeCloseTo(0.5)
    expect(computePdfRender(306, PAGE_W, PAGE_H, 1).cssW).toBeLessThanOrEqual(306)
    expect(computePdfRender(1224, PAGE_W, PAGE_H, 1).fitScale).toBeCloseTo(2)
    expect(computePdfRender(1224, PAGE_W, PAGE_H, 1).cssW).toBeLessThanOrEqual(1224)
  })

  describe('zoom (B18)', () => {
    it('zoom > 1 widens the page beyond the container so it scrolls', () => {
      const fit = computePdfRender(612, PAGE_W, PAGE_H, 1)
      const z2 = computePdfRender(612, PAGE_W, PAGE_H, 1, 2)
      expect(z2.scale).toBeCloseTo(fit.fitScale * 2)
      expect(z2.cssW).toBe(1224) // 612 × 2 — wider than the 612px container
      expect(z2.cssW).toBeGreaterThan(612) // ⇒ horizontal scroll available
      expect(z2.cssH).toBe(1584)
    })

    it('zoom multiplies on top of a non-unit fit scale', () => {
      // narrow pane (fit 0.5) zoomed 2× ⇒ effective scale 1.0, page at natural size
      const { scale, cssW } = computePdfRender(306, PAGE_W, PAGE_H, 1, 2)
      expect(scale).toBeCloseTo(1)
      expect(cssW).toBe(612)
      expect(cssW).toBeGreaterThan(306) // overflows the narrow pane ⇒ scroll
    })

    it('zoom === 1 is exactly fit (no overflow)', () => {
      const z1 = computePdfRender(800, PAGE_W, PAGE_H, 1, 1)
      const fit = computePdfRender(800, PAGE_W, PAGE_H, 1)
      expect(z1.scale).toBeCloseTo(fit.fitScale)
      expect(z1.cssW).toBeLessThanOrEqual(800)
    })
  })
})

describe('clampZoom (B18)', () => {
  it('never goes below fit (min = 1)', () => {
    expect(clampZoom(0.5)).toBe(ZOOM_MIN)
    expect(clampZoom(0)).toBe(1)
    expect(clampZoom(-3)).toBe(1)
  })

  it('caps at the maximum', () => {
    expect(clampZoom(99)).toBe(ZOOM_MAX)
    expect(clampZoom(5.0001)).toBe(5)
  })

  it('passes through in-range values', () => {
    expect(clampZoom(2.5)).toBe(2.5)
    expect(clampZoom(1)).toBe(1)
    expect(clampZoom(5)).toBe(5)
  })
})
