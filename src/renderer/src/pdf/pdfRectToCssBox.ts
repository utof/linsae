/**
 * Map a PDF user-space rect to a CSS box inside the page's content element.
 *
 * PDF user space is y-UP, so `rect[1]` (`minY` from `clientRectsToPdfRect`) is the
 * VISUAL BOTTOM and the visual top is `y + h`. Taking min/max over both converted
 * corners keeps this correct under page rotation too.
 *
 * @see src/renderer/src/pdf/clientRectsToPdfRect.ts (the inverse, at capture time)
 * @see docs/specs/v0.8-multipage-pdf.md §5.4
 * @issue utof/linsae#155
 */
export function pdfRectToCssBox(
  viewport: { convertToViewportPoint: (x: number, y: number) => [number, number] },
  rect: readonly [number, number, number, number],
): { left: number; top: number; width: number; height: number } {
  const [x, y, w, h] = rect
  const [x1, y1] = viewport.convertToViewportPoint(x, y + h) // visual top-left
  const [x2, y2] = viewport.convertToViewportPoint(x + w, y) // visual bottom-right
  return {
    left: Math.min(x1, x2),
    top: Math.min(y1, y2),
    width: Math.abs(x2 - x1),
    height: Math.abs(y2 - y1),
  }
}
