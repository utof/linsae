/**
 * Pure geometry for rendering a PDF page that (a) fits the pane width, (b) lets
 * the user zoom in past fit, and (c) renders at the display's device-pixel-ratio
 * for crisp output.
 *
 * Three scales compose here and must not be conflated:
 *  - `fitScale` = containerWidth / unscaledWidth — the CSS scale at which the
 *    page exactly fills the pane width (the zoom === 1 baseline).
 *  - `zoom` (≥ 1) is a user multiplier on top of fit (ctrl/cmd + wheel). The
 *    effective viewport scale fed to `page.getViewport({ scale })` is therefore
 *    `scale = fitScale * zoom`, mirrored to the text layer's
 *    `--total-scale-factor` so the selectable overlay stays aligned (the text
 *    layer is laid out entirely in CSS space — see pdf.js `setLayerDimensions`).
 *  - `dpr` (devicePixelRatio) scales only the *backing store* (canvas bitmap)
 *    so a HiDPI display gets a 1:1-or-denser pixel mapping instead of an
 *    upscaled, blurry bitmap. It never touches the CSS size or the viewport
 *    scale, so excerpt coordinate math (`convertToPdfPoint`, CSS-space) and
 *    text-layer alignment are unaffected by it.
 *
 * `cssW`/`cssH` are floored (B17): the canvas's CSS display size must never
 * exceed the container width or a sub-pixel rounding remainder produces a stray
 * horizontal scrollbar at fit. Flooring also matches pdf.js's own text-layer
 * sizing (`round(down, --total-scale-factor * pageWidth, …)`), keeping the
 * overlay aligned. The dpr is folded into the render call as the affine
 * `transform` `[dpr,0,0,dpr,0,0]`, `undefined` when `dpr === 1`.
 *
 * Why: B8 (low quality) was a missing-dpr backing store; B9 (overflow) was a
 * hardcoded 1.2× scale; B17 (a stray h-scrollbar when the panel shrank) was the
 * sub-pixel/scrollbar-width slack; B18 added ctrl/cmd-wheel zoom over fit.
 *
 * @see https://github.com/mozilla/pdf.js/blob/master/examples/learning/helloworld.html (canonical HiDPI canvas + `transform` pattern, verified via context7 2026-06-30)
 * @see docs/specs/v0.6-pdf-slim-slice.md §4 (coordinate space)
 */
interface PdfRenderDims {
  /** CSS scale that fits the page to the container width (the zoom===1 base). */
  fitScale: number
  /** Effective viewport scale = `fitScale * zoom` (feeds `getViewport`). */
  scale: number
  /** Canvas CSS width in px, floored (≤ containerWidth at zoom 1; > when zoomed). */
  cssW: number
  /** Canvas CSS height in px, floored (preserves the page aspect ratio). */
  cssH: number
  /** Canvas backing-store width in px (`cssW × dpr`, rounded). */
  bitmapW: number
  /** Canvas backing-store height in px (`cssH × dpr`, rounded). */
  bitmapH: number
  /** pdf.js render affine transform; `undefined` when `dpr === 1`. */
  transform: [number, number, number, number, number, number] | undefined
}

/** Minimum zoom = fit-to-width — the "just right" baseline; never go smaller. */
export const ZOOM_MIN = 1
/** Maximum zoom multiplier over fit-to-width. */
export const ZOOM_MAX = 5

/**
 * Clamp a zoom multiplier to `[ZOOM_MIN, ZOOM_MAX]`.
 * Why: fit (1) is the smallest useful scale (B18 — never zoom out below fit),
 * and an unbounded zoom would render an enormous, memory-heavy bitmap.
 */
export function clampZoom(zoom: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom))
}

/**
 * Compute the fit-to-width + zoom + HiDPI canvas dimensions for one PDF page.
 *
 * @param containerWidth - The pane's content width in CSS px (`clientWidth`,
 *   which already excludes border + the reserved scrollbar gutter).
 * @param unscaledViewportWidth - `page.getViewport({ scale: 1 }).width`.
 * @param unscaledViewportHeight - `page.getViewport({ scale: 1 }).height`.
 * @param dpr - `window.devicePixelRatio || 1`.
 * @param zoom - User zoom multiplier over fit (≥ 1, default 1 = fit).
 */
export function computePdfRender(
  containerWidth: number,
  unscaledViewportWidth: number,
  unscaledViewportHeight: number,
  dpr: number,
  zoom = 1,
): Readonly<PdfRenderDims> {
  const fitScale = containerWidth / unscaledViewportWidth
  const scale = fitScale * zoom
  const cssW = Math.floor(unscaledViewportWidth * scale)
  const cssH = Math.floor(unscaledViewportHeight * scale)
  return {
    fitScale,
    scale,
    cssW,
    cssH,
    bitmapW: Math.round(cssW * dpr),
    bitmapH: Math.round(cssH * dpr),
    transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
  }
}
