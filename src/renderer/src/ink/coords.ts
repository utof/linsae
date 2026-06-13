/**
 * Coordinate mapping: client (viewport) space → image (SVG viewBox) space.
 *
 * The SVG element may be scaled/translated by CSS (e.g. `objectFit:contain` letterboxing
 * inside a container). `getScreenCTM()` returns the transform from the SVG's user-space
 * (= image-pixel space) to screen pixels. Inverting it maps screen/client coordinates
 * back to image-pixel space, so strokes are stored in `viewBox` units regardless of
 * container size, device pixel ratio, or letterboxing.
 *
 * Why DOM-only: this module is context-free (ink/ import rule). DOMMatrix and DOMPoint
 * are standard DOM APIs available in Chromium (our only target) and happy-dom (test env).
 *
 * @see docs/specs/v0.2.5-screenshot-annotation.md §"Coordinate mapping"
 * @see adrs/0027-context-free-ink-module.md
 */

/**
 * Maps a client-space pointer event coordinate to image-pixel (SVG viewBox) space.
 *
 * Uses `svg.getScreenCTM()!.inverse()` applied to the pointer coordinates via a `DOMPoint`.
 * The `!` is correct: the SVG is always in the document when receiving pointer events
 * (detached elements return null, but that can't happen here).
 *
 * Why `DOMPoint` + `matrixTransform`: the spec-standard way to transform a 2D point by a
 * `DOMMatrix`; `matrixTransform` is more explicit than manual `(x*a + e)` decomposition.
 *
 * @param svg  - The `<svg>` element whose `viewBox` defines image space.
 * @param clientX - `PointerEvent.clientX` (viewport-relative).
 * @param clientY - `PointerEvent.clientY` (viewport-relative).
 * @returns A `DOMPoint` with `x`/`y` in image-pixel space.
 * @see https://developer.mozilla.org/en-US/docs/Web/API/SVGGraphicsElement/getScreenCTM
 */
export function clientToImagePoint(svg: SVGSVGElement, clientX: number, clientY: number): DOMPoint {
  const ctm = svg.getScreenCTM()!
  const m = ctm.inverse()
  // Apply the 2D affine transform manually.
  // Why: DOMPoint.matrixTransform is unimplemented in happy-dom (our test env), and
  // the manual form is straightforward for 2D: x' = m.a*x + m.c*y + m.e, y' = m.b*x + m.d*y + m.f.
  // In production (Chromium), matrixTransform is available; the manual form is equivalent
  // and fully correct for non-perspective 2D transforms (SVG CTM is always 2D affine).
  // @see https://developer.mozilla.org/en-US/docs/Web/API/DOMMatrix
  const x = m.a * clientX + m.c * clientY + m.e
  const y = m.b * clientX + m.d * clientY + m.f
  return new DOMPoint(x, y)
}
