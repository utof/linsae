/**
 * Pure geometry for rendering a PDF page that both (a) fits the pane width and
 * (b) renders at the display's device-pixel-ratio for crisp output.
 *
 * Two independent scales compose here and must not be conflated:
 *  - `fitScale` sizes the *CSS* box so the page exactly fills the container
 *    width (fit-to-width; no horizontal overflow). Applied via
 *    `page.getViewport({ scale: fitScale })`, and mirrored to the text layer's
 *    `--total-scale-factor` so the selectable overlay stays aligned (the text
 *    layer is laid out entirely in CSS space — see pdf.js `setLayerDimensions`).
 *  - `dpr` (devicePixelRatio) scales only the *backing store* (canvas bitmap)
 *    so a HiDPI display gets a 1:1-or-denser pixel mapping instead of an
 *    upscaled, blurry bitmap. It never touches the CSS size or the viewport
 *    scale, so excerpt coordinate math (`convertToPdfPoint`, CSS-space) and
 *    text-layer alignment are unaffected by it.
 *
 * The dpr is folded into the render call as the affine `transform`
 * `[dpr,0,0,dpr,0,0]` (pdf.js scales its output into the larger bitmap), and is
 * `undefined` when `dpr === 1` so the non-HiDPI path passes nothing extra.
 *
 * Why: B8 (low render quality) was a missing-dpr backing store; B9 (page
 * overflow) was a hardcoded 1.2× render scale instead of fit-to-width.
 *
 * @see https://github.com/mozilla/pdf.js/blob/master/examples/learning/helloworld.html (canonical HiDPI canvas + `transform` pattern, verified via context7 2026-06-30)
 * @see docs/specs/v0.6-pdf-slim-slice.md §4 (coordinate space)
 */
interface PdfRenderDims {
  /** CSS-space scale applied to the page so it fits the container width. */
  fitScale: number
  /** Canvas CSS width in px (equals the container width). */
  cssW: number
  /** Canvas CSS height in px (preserves the page aspect ratio). */
  cssH: number
  /** Canvas backing-store width in px (`cssW × dpr`, rounded). */
  bitmapW: number
  /** Canvas backing-store height in px (`cssH × dpr`, rounded). */
  bitmapH: number
  /** pdf.js render affine transform; `undefined` when `dpr === 1`. */
  transform: [number, number, number, number, number, number] | undefined
}

/**
 * Compute the fit-to-width + HiDPI canvas dimensions for one PDF page.
 *
 * @param containerWidth - The pane's content width in CSS px (`clientWidth`).
 * @param unscaledViewportWidth - `page.getViewport({ scale: 1 }).width`.
 * @param unscaledViewportHeight - `page.getViewport({ scale: 1 }).height`.
 * @param dpr - `window.devicePixelRatio || 1`.
 */
export function computePdfRender(
  containerWidth: number,
  unscaledViewportWidth: number,
  unscaledViewportHeight: number,
  dpr: number,
): Readonly<PdfRenderDims> {
  const fitScale = containerWidth / unscaledViewportWidth
  const cssW = unscaledViewportWidth * fitScale
  const cssH = unscaledViewportHeight * fitScale
  return {
    fitScale,
    cssW,
    cssH,
    bitmapW: Math.round(cssW * dpr),
    bitmapH: Math.round(cssH * dpr),
    transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
  }
}
