/**
 * Pure camera math for the canvas stage. Camera = world coords of the
 * viewport's top-left + zoom. Zoom is a camera property, never stored per
 * node (spec §1). ZOOM_MIN sits exactly on the title-tier threshold so
 * normal use never leaves card tier (spec §3); the dev LOD flag may pass
 * `{ clamp: false }` to go below it (spec §12).
 * @see docs/specs/v0.4-canvas-mvp.md §3 §12
 */
import { TIER_THRESHOLDS } from './lod'

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
