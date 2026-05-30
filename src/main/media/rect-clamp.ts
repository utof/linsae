/**
 * Clamp a capture rect (CSS px / DIP, from the renderer's
 * getBoundingClientRect) to the viewport and round to integer pixels before it
 * is handed to `webContents.capturePage`. Pure so it is unit-testable without
 * Electron (spec §Capture subsystem: "read the iframe rect … clamp to the
 * viewport").
 *
 * @see docs/specs/v0.2-youtube-annotation.md §Capture subsystem
 */
export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** Clamps `rect` inside `{width,height}` and rounds to integers. */
export function clampRect(rect: Rect, view: { width: number; height: number }): Rect {
  const x = Math.min(Math.max(0, Math.round(rect.x)), view.width)
  const y = Math.min(Math.max(0, Math.round(rect.y)), view.height)
  const width = Math.min(Math.round(rect.width + Math.min(0, rect.x)), view.width - x)
  const height = Math.min(Math.round(rect.height + Math.min(0, rect.y)), view.height - y)
  return { x, y, width: Math.max(0, width), height: Math.max(0, height) }
}
