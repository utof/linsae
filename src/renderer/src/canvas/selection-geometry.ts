/**
 * Pure geometry helpers for canvas selection: marquee normalization, the
 * placed-cards centroid (centroid arrow §14), and arrow-key nudge deltas
 * (8 world px, spec §8). World coordinates throughout — no DOM, no camera.
 * @see docs/specs/v0.4-canvas-mvp.md §8 §14
 */
import type { Point } from './camera'
import type { WorldRect } from './spatial-index'

/** Nudge step in world px (spec §8). */
export const NUDGE_PX = 8

/** Normalize two world points into a {minX,minY,maxX,maxY} rect (marquee). */
export function marqueeRect(
  a: Point,
  b: Point,
): { minX: number; minY: number; maxX: number; maxY: number } {
  return {
    minX: Math.min(a.x, b.x),
    minY: Math.min(a.y, b.y),
    maxX: Math.max(a.x, b.x),
    maxY: Math.max(a.y, b.y),
  }
}

/** Average center of a set of card rects, or null when empty (§14 arrow). */
export function centroid(rects: WorldRect[]): Point | null {
  if (rects.length === 0) return null
  let sx = 0
  let sy = 0
  for (const r of rects) {
    sx += r.x + r.w / 2
    sy += r.y + r.h / 2
  }
  return { x: sx / rects.length, y: sy / rects.length }
}

/** Arrow-key → world-px delta, or null for a non-arrow key. */
export function nudgeDelta(key: string): { dx: number; dy: number } | null {
  switch (key) {
    case 'ArrowLeft':
      return { dx: -NUDGE_PX, dy: 0 }
    case 'ArrowRight':
      return { dx: NUDGE_PX, dy: 0 }
    case 'ArrowUp':
      return { dx: 0, dy: -NUDGE_PX }
    case 'ArrowDown':
      return { dx: 0, dy: NUDGE_PX }
    default:
      return null
  }
}
