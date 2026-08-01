/**
 * The reader's single scroll primitive: a position as a page plus a normalized
 * fraction within it, not a pixel offset.
 *
 * Why not pixels: page heights depend on zoom, dock width and dpr, so a pixel
 * offset is not portable across a zoom step or a restart. A page fraction is
 * scale-independent, letting ONE mechanism serve all four jumps — zoom re-anchor,
 * boot restore, read-back, jump-to-page.
 *
 * The virtualizer's `getOffsetForIndex` is deliberately NOT used: it returns a
 * tuple, reads the DOM, returns 0 with no scroll element, and with the default
 * `align:'auto'` returns the CURRENT offset when the item is on screen
 * (`virtual-core/dist/esm/index.js:963`) — a read-back jump would often not scroll.
 *
 * @see docs/specs/v0.8-multipage-pdf.md §4.6
 * @issue utof/linsae#154
 */

/** The subset of a virtualizer measurement this module needs. */
export interface AnchorItem {
  /** 0-based virtual index (page number − 1). */
  index: number
  /** Item start offset in the scroll container, px. */
  start: number
  /** Item measured/estimated height, px. */
  size: number
}

/** A scale-independent reader position; `fraction` is always within `[0, 1]`. */
export interface PageAnchor {
  /** 1-based page number (pdf.js numbering). */
  page: number
  /** 0 = page top edge, 1 = bottom edge. */
  fraction: number
}

// NaN is special-cased because `Math.max(0, NaN)` is NaN, so a bare min/max would
// return NaN and `offsetFromAnchor` would hand the CSSOM a non-finite scrollTop, which
// it normalizes to 0 — silently jumping to page 1 rather than clamping within the page,
// breaking the guarantee stated on `offsetFromAnchor` below.
// ±Infinity needs NO special case: min/max already carry them to 1 and 0, which is the
// right reading of "past the end" / "before the start". @issue utof/linsae#184
const clamp01 = (n: number): number => (Number.isNaN(n) ? 0 : Math.min(1, Math.max(0, n)))

/**
 * Scroll offset → page anchor, given the item covering that offset.
 * `size === 0` (an unmeasured page at boot) yields fraction 0, never NaN.
 * @see AnchorItem
 */
export function anchorFromOffset(offset: number, item: AnchorItem): PageAnchor {
  const fraction = item.size > 0 ? (offset - item.start) / item.size : 0
  return { page: item.index + 1, fraction: clamp01(fraction) }
}

/**
 * Page anchor → scroll offset. `fraction` is clamped so a corrupted persisted
 * value can never scroll outside the page.
 * @see PageAnchor
 */
export function offsetFromAnchor(fraction: number, item: AnchorItem): number {
  return item.start + clamp01(fraction) * item.size
}
