// src/renderer/src/panes/dock-widths.ts
import { FEED_BAND } from '../feed/feedBand'

export type PaneKind = 'utility' | 'content'

/** Width bands (px) per pane kind. Utility = the v0.4 220–400 band; content
 *  (a PDF reader) = the v0.6 400–900 band. Single source: the store clamps to
 *  these and DockHost defaults from them; Dock renders the controlled width.
 *  @see docs/specs/v0.6.2-dock-shell.md §1 */
export const DOCK_WIDTH: Record<PaneKind, { min: number; max: number; default: number }> = {
  utility: { min: 220, max: 400, default: 280 },
  content: { min: 400, max: 900, default: 600 },
}

/** Clamp a width to the kind's band. @see DOCK_WIDTH */
export function clampWidth(kind: PaneKind, width: number): number {
  const band = DOCK_WIDTH[kind]
  return Math.min(band.max, Math.max(band.min, width))
}

/** The default width for a kind when no remembered width exists. @see DOCK_WIDTH */
export function defaultWidthFor(kind: PaneKind): number {
  return DOCK_WIDTH[kind].default
}

/**
 * Largest a dock of `kind` may RENDER so the feed keeps at least `FEED_BAND.min`
 * and the two docks can never overlap the feed (B14 / ADR 0047): the room left
 * after reserving the feed minimum and the OTHER dock's width, bounded by this
 * kind's own `[min, max]` band.
 *
 * Why floor at the kind min (not at the room): on a pathologically narrow window
 * where even `feedMin + bothDockMins` doesn't fit, the dock stays at its usable
 * minimum and the FEED — which carries no CSS `min-width` (see Feed/Composer band)
 * — simply shrinks past its nominal min. The dock can never cross INTO the feed,
 * so there is no overlap at any width; the feed degrades gracefully instead.
 *
 * Symmetric by construction: capping each side against the other's width keeps
 * `leftEff + rightEff ≤ windowWidth − feedMin` (each `eff ≤ otherSideRoom`), so
 * the result is invariant to how many panes/docks are open.
 *
 * @param kind        the dock's kind (its widest resident pane's band bounds the cap)
 * @param otherWidth  the other dock's current width (0 if that side is closed)
 * @param windowWidth measured body-row (≈ window) width in px
 * @see adrs/0047-feed-default-width-docks-fill-gutters.md
 */
export function maxDockWidth(kind: PaneKind, otherWidth: number, windowWidth: number): number {
  const band = DOCK_WIDTH[kind]
  const room = windowWidth - FEED_BAND.min - otherWidth
  return Math.max(band.min, Math.min(band.max, room))
}
