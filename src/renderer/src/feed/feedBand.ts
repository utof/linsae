// src/renderer/src/feed/feedBand.ts

/**
 * Feed band geometry constants (px).
 *
 * - `default` is the feed's centered content width AND its maximum — the
 *   pre-dock-shell `maxWidth: 720` the feed has always used (Feed.tsx).
 * - `min` is the floor the feed shrinks to when a dock is widened far enough to
 *   encroach; the feed never drops below it ("never let the feed vanish").
 *
 * @see adrs/0047-feed-default-width-docks-fill-gutters.md
 */
export const FEED_BAND = { min: 360, default: 720 } as const

/** Resolved feed-band layout: a max width plus the asymmetric left/right margins
 *  that keep the band centered in the WINDOW (not in the dock-shrunken `<main>`). */
export interface FeedBand {
  maxWidth: number
  marginLeft: number
  marginRight: number
}

/**
 * Compute the feed band so the feed stays centered in the WINDOW while open docks
 * fill the side gutters — "Model A" (ADR 0047). While free horizontal space
 * exists, a dock sits in its gutter and the feed neither moves nor shrinks. Only
 * once a dock is widened past its gutter does the feed give way: it shrinks toward
 * {@link FEED_BAND}.min and slides flush against the dock rather than under it.
 *
 * The math runs in window coordinates: `<main>` spans `[leftW, winW - rightW]`,
 * so a centered band's window-left edge is `(winW - width) / 2`; we clamp that so
 * the band never overlaps either dock, then convert back to margins relative to
 * `<main>`'s content box (which begins at `leftW`). Symmetric for both docks by
 * construction — left and right go through the identical clamp.
 *
 * @param winW   measured body-row (≈ window) width in px
 * @param leftW  left dock width in px (0 when the left dock is closed)
 * @param rightW right dock width in px (0 when the right dock is closed)
 * @returns the band geometry, or `null` when no dock is open or the width is not
 *   yet measured — the caller then uses the default centered `maxWidth` + auto
 *   margins (byte-identical to the pre-dock layout).
 * @see adrs/0047-feed-default-width-docks-fill-gutters.md
 */
export function computeFeedBand(winW: number, leftW: number, rightW: number): FeedBand | null {
  if (winW <= 0 || (leftW <= 0 && rightW <= 0)) return null
  const remaining = winW - leftW - rightW
  const maxWidth = Math.max(FEED_BAND.min, Math.min(FEED_BAND.default, remaining))
  // Desired: centered in the window. Then clamp so the band clears both docks.
  let left = (winW - maxWidth) / 2
  left = Math.max(leftW, left)
  if (left + maxWidth > winW - rightW) left = winW - rightW - maxWidth
  left = Math.max(leftW, left)
  const marginLeft = left - leftW
  const marginRight = Math.max(0, remaining - maxWidth - marginLeft)
  return { maxWidth, marginLeft, marginRight }
}
