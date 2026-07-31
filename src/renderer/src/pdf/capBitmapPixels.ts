/**
 * Upper bound on one page's canvas backing store, in pixels.
 *
 * 2^24 ≈ 16.7M px ≈ 67 MB at 4 bytes/px — deliberately HALF of pdf.js v6's
 * `maxCanvasPixels` default of 2^25 (`legacy/web/pdf_viewer.mjs:10135`, verified
 * against the pinned pdfjs-dist 6.0.227). Half, not equal, because its viewer caps
 * ONE canvas where this reader keeps 3-5 pages resident at once. (pdf.js also
 * overrides to 5,242,880 on mobile at `:9911` and enforces a separate per-dimension
 * `maxCanvasDim: 32767` at `:9951`; an area cap alone keeps the larger dimension
 * under that for any page flatter than roughly 1:64, so no analogue is needed here.)
 *
 * Why: backing-store area scales with zoom², and `ZOOM_MAX` is 5
 * (`computePdfRender.ts:54`). Uncapped, one page at max zoom on a 900px dock at
 * dpr 2 is ~419 MB; 3–5 resident pages would be 1.25–2.1 GB.
 *
 * @see docs/specs/v0.8-multipage-pdf.md §4.4
 */
export const MAX_PAGE_BITMAP_PX = 16_777_216

interface CappedBitmap {
  bitmapW: number
  bitmapH: number
  transform: [number, number, number, number, number, number] | undefined
}

/**
 * APPROXIMATELY bound a page's canvas backing store to `maxPx` total pixels by
 * degrading the effective device-pixel-ratio — never the CSS size, which stays at
 * `computePdfRender`'s `cssW`/`cssH` so the page CSS-upscales past the cap.
 *
 * Deliberately SEPARATE from `computePdfRender` so that verified v0.6 function
 * stays byte-identical; below the cap this is the identity, which is what makes
 * the page-1 no-regression criterion provable.
 *
 * CRITICAL: the returned scalar must NEVER be fed to the text layer's
 * `--scale-factor` / `--total-scale-factor` — those stay at `viewport.scale`
 * (`PdfReader.tsx:211-212`). The cap changes only the raster resolution; if the
 * overlay followed it, selectable text would drift out of alignment exactly where
 * the cap engages and excerpt rects would be silently wrong.
 *
 * @param cssW - `computePdfRender().cssW`.
 * @param cssH - `computePdfRender().cssH`.
 * "Approximately" is literal: the returned dims are `Math.round`ed, so the product
 * can land a few thousand px above `maxPx` (worst case measured: +3,444 px, or
 * 0.02% of the budget — ~14 KB against 67 MB). `Math.floor` would remove the
 * overshoot but break the identity-with-`computePdfRender` contract at fractional
 * dpr, which is the property that makes the page-1 no-regression criterion provable.
 * The overshoot is accepted; the identity is not negotiable.
 *
 * @param dpr - `window.devicePixelRatio || 1`.
 * @param maxPx - Pixel ceiling; defaults to `MAX_PAGE_BITMAP_PX`.
 * @see docs/specs/v0.8-multipage-pdf.md §4.4
 */
export function capBitmapPixels(
  cssW: number,
  cssH: number,
  dpr: number,
  maxPx: number = MAX_PAGE_BITMAP_PX,
): Readonly<CappedBitmap> {
  const area = cssW * cssH
  // area·dpr² ≤ maxPx ⟺ dpr ≤ sqrt(maxPx/area), so min() is the identity when it fits.
  const effectiveDpr = area > 0 ? Math.min(dpr, Math.sqrt(maxPx / area)) : dpr
  return {
    bitmapW: Math.round(cssW * effectiveDpr),
    bitmapH: Math.round(cssH * effectiveDpr),
    transform: effectiveDpr !== 1 ? [effectiveDpr, 0, 0, effectiveDpr, 0, 0] : undefined,
  }
}
