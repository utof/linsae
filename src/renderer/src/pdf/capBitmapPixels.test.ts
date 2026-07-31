// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { capBitmapPixels, MAX_PAGE_BITMAP_PX } from './capBitmapPixels'
import { computePdfRender } from './computePdfRender'

describe('capBitmapPixels', () => {
  it('is IDENTITY below the cap — byte-identical to computePdfRender (the v0.6 case)', () => {
    const base = computePdfRender(900, 612, 792, 2, 1)
    const capped = capBitmapPixels(base.cssW, base.cssH, 2)
    expect(capped.bitmapW).toBe(base.bitmapW)
    expect(capped.bitmapH).toBe(base.bitmapH)
    expect(capped.transform).toEqual(base.transform)
  })

  it('drops transform to undefined at dpr 1 below the cap (matches computePdfRender)', () => {
    expect(capBitmapPixels(900, 1165, 1).transform).toBeUndefined()
  })

  it('caps total pixels at ZOOM_MAX rather than allocating unbounded', () => {
    const base = computePdfRender(900, 612, 792, 2, 5) // zoom 5
    const capped = capBitmapPixels(base.cssW, base.cssH, 2)
    expect(base.bitmapW * base.bitmapH).toBeGreaterThan(MAX_PAGE_BITMAP_PX) // precondition
    expect(capped.bitmapW * capped.bitmapH).toBeLessThanOrEqual(MAX_PAGE_BITMAP_PX)
    expect(capped.bitmapW * capped.bitmapH).toBeGreaterThan(MAX_PAGE_BITMAP_PX * 0.98)
  })

  it('emits a DOWNSCALE transform when the cap binds at dpr 1', () => {
    const t = capBitmapPixels(6000, 6000, 1).transform
    expect(t).toBeDefined()
    expect(t![0]).toBeLessThan(1)
  })

  it('never upscales beyond the requested dpr', () => {
    expect(capBitmapPixels(100, 100, 2).bitmapW).toBe(200)
  })

  it('handles a zero-area page without NaN', () => {
    expect(Number.isNaN(capBitmapPixels(0, 0, 2).bitmapW)).toBe(false)
  })
})
