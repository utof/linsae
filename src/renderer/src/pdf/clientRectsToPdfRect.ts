/**
 * Convert a DOM Selection's client rects to a PDF user-space rect
 * `[x, y, w, h]` (scale-independent). Takes the page's pdf.js viewport
 * (for `convertToPdfPoint`), the page container's `getBoundingClientRect()`
 * (to subtract page offset from client coords), and the client rects.
 *
 * Returns the bounding box of all client rects. Empty input → [0,0,0,0].
 * @see docs/specs/v0.6-pdf-slim-slice.md §4 (coordinate space)
 */
export function clientRectsToPdfRect(
  viewport: { convertToPdfPoint: (x: number, y: number) => [number, number] },
  pageRect: { left: number; top: number },
  clientRects: ArrayLike<{ left: number; top: number; right: number; bottom: number }>,
): [number, number, number, number] {
  const rects = Array.from(clientRects)
  if (rects.length === 0) return [0, 0, 0, 0]
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity
  for (const r of rects) {
    const [x1, y1] = viewport.convertToPdfPoint(r.left - pageRect.left, r.top - pageRect.top)
    const [x2, y2] = viewport.convertToPdfPoint(r.right - pageRect.left, r.bottom - pageRect.top)
    minX = Math.min(minX, x1, x2)
    minY = Math.min(minY, y1, y2)
    maxX = Math.max(maxX, x1, x2)
    maxY = Math.max(maxY, y1, y2)
  }
  return [minX, minY, maxX - minX, maxY - minY]
}
