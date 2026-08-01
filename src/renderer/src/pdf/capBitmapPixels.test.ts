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
    // 1.001, not an exact ceiling: the dims are Math.round'ed, so the product can sit
    // a few thousand px over (worst measured +3,444 = 0.02%). Math.floor would remove
    // the overshoot but break identity-with-computePdfRender at fractional dpr. This
    // fixture happens to land 157px UNDER the cap, so an exact assertion here would be
    // green by luck and would go red on an unrelated fixture change.
    expect(capped.bitmapW * capped.bitmapH).toBeLessThanOrEqual(MAX_PAGE_BITMAP_PX * 1.001)
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

  it('honours an explicit maxPx, so the cap is a parameter and not just a constant', () => {
    // The 4th param had no coverage; a small explicit ceiling also makes the cap
    // arithmetic checkable by hand instead of against an 8-digit constant.
    const capped = capBitmapPixels(1000, 1000, 4, 1_000_000)
    expect(capped.bitmapW).toBe(1000) // sqrt(1e6/1e6) = 1, so dpr degrades 4 -> 1
    expect(capped.bitmapW * capped.bitmapH).toBeLessThanOrEqual(1_000_000)
  })

  it('drops the transform when the cap lands EXACTLY on dpr 1', () => {
    // 4096*4096*1 == 2^24 exactly, so effectiveDpr is precisely 1 and the result must
    // be indistinguishable from the uncapped dpr-1 case — no identity transform.
    const capped = capBitmapPixels(4096, 4096, 2)
    expect(capped.transform).toBeUndefined()
    expect(capped.bitmapW).toBe(4096)
  })
})
