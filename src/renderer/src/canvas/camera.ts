/**
 * Pure camera math for the canvas stage. Camera = world coords of the
 * viewport's top-left + zoom. Zoom is a camera property, never stored per
 * node (spec §1). ZOOM_MIN sits exactly on the title-tier threshold so
 * normal use never leaves card tier (spec §3); the dev LOD flag may pass
 * `{ clamp: false }` to go below it (spec §12).
 * @see docs/specs/v0.4-canvas-mvp.md §3 §12
 */
import { TIER_THRESHOLDS } from './lod'
import type { WorldRect } from './spatial-index'

export interface Camera {
  x: number
  y: number
  zoom: number
}

export interface Point {
  x: number
  y: number
}

export const ZOOM_MIN = TIER_THRESHOLDS.title
export const ZOOM_MAX = 2.0

/** Clamp a zoom to the user range [0.5, 2.0]. @see docs/specs/v0.4-canvas-mvp.md §3 */
export function clampZoom(zoom: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom))
}

/** World point → viewport-relative screen point. */
export function worldToScreen(c: Camera, w: Point): Point {
  return { x: (w.x - c.x) * c.zoom, y: (w.y - c.y) * c.zoom }
}

/** Viewport-relative screen point → world point. */
export function screenToWorld(c: Camera, s: Point): Point {
  return { x: c.x + s.x / c.zoom, y: c.y + s.y / c.zoom }
}

/**
 * Zoom about a screen point (the cursor): the world point under it stays
 * fixed. Why exp-style factors compose cleanly across wheel events.
 * @see docs/specs/v0.4-canvas-mvp.md §3 (zoom about the cursor)
 */
export function zoomAboutPoint(
  c: Camera,
  s: Point,
  factor: number,
  opts: { clamp?: boolean } = {},
): Camera {
  const raw = c.zoom * factor
  const zoom = (opts.clamp ?? true) ? clampZoom(raw) : raw
  const w = screenToWorld(c, s)
  return { x: w.x - s.x / zoom, y: w.y - s.y / zoom, zoom }
}

/** Pan by a screen-space delta (drag): camera moves opposite the drag. */
export function panBy(c: Camera, d: { dx: number; dy: number }): Camera {
  return { x: c.x - d.dx / c.zoom, y: c.y - d.dy / c.zoom, zoom: c.zoom }
}

/**
 * World-space rect of the viewport inflated by `inflate` viewport-sizes on
 * each side — the rbush query rect (spec §3: one viewport-size margin).
 */
export function visibleWorldRect(
  c: Camera,
  viewportW: number,
  viewportH: number,
  inflate: number,
): { minX: number; minY: number; maxX: number; maxY: number } {
  const w = viewportW / c.zoom
  const h = viewportH / c.zoom
  return {
    minX: c.x - inflate * w,
    minY: c.y - inflate * h,
    maxX: c.x + w + inflate * w,
    maxY: c.y + h + inflate * h,
  }
}

/**
 * Camera that frames every rect with `pad` screen px of margin, centered, zoom
 * clamped to the user range. Empty set → returns `current` unchanged (fit is a
 * no-op at zero cards, spec §14). `current` defaults to {0,0,1} when omitted.
 * @see docs/specs/v0.4-canvas-mvp.md §14 (status-bar fit)
 */
export function fitCamera(
  rects: WorldRect[],
  viewportW: number,
  viewportH: number,
  pad: number,
  current: Camera = { x: 0, y: 0, zoom: 1 },
): Camera {
  if (rects.length === 0) return current
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const r of rects) {
    minX = Math.min(minX, r.x)
    minY = Math.min(minY, r.y)
    maxX = Math.max(maxX, r.x + r.w)
    maxY = Math.max(maxY, r.y + r.h)
  }
  const cw = maxX - minX
  const ch = maxY - minY
  // Available screen space after padding; guard against zero.
  const availW = Math.max(1, viewportW - 2 * pad)
  const availH = Math.max(1, viewportH - 2 * pad)
  // clampZoom's ZOOM_MIN (0.5) floor is intentional (spec §3): a board wider/taller
  // than ~2x the viewport cannot fully fit on screen — fit stops zooming out at the
  // title-tier threshold rather than leaving card tier. This is by design; do NOT
  // relax the clamp to "make fit always frame everything".
  const zoom = clampZoom(Math.min(availW / Math.max(1, cw), availH / Math.max(1, ch)))
  const cx = (minX + maxX) / 2
  const cy = (minY + maxY) / 2
  return { x: cx - viewportW / zoom / 2, y: cy - viewportH / zoom / 2, zoom }
}

/**
 * Camera that centers one rect in the viewport at `zoom` (jump-to-card —
 * spec §4/§5/§9/§14). Zoom is clamped to the user range.
 */
export function centerCamera(
  rect: WorldRect,
  viewportW: number,
  viewportH: number,
  zoom: number,
): Camera {
  const z = clampZoom(zoom)
  const cx = rect.x + rect.w / 2
  const cy = rect.y + rect.h / 2
  return { x: cx - viewportW / z / 2, y: cy - viewportH / z / 2, zoom: z }
}
