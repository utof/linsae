/**
 * Upper bound on one page's canvas backing store, in pixels.
 *
 * 2^24 ≈ 16.7M px ≈ 67 MB at 4 bytes/px — matching pdf.js's own `maxCanvasPixels`
 * default, the same trade-off its viewer makes.
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
 * Bound a page's canvas backing store to `maxPx` total pixels by degrading the
 * effective device-pixel-ratio — never the CSS size, which stays at
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
