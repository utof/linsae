// src/renderer/src/panes/dock-widths.ts
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
