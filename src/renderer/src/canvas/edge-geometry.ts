/**
 * Edge segment between two cards: anchored center-to-center, clipped at
 * card bounds (spec §11). Returns null when the clipped segment would be
 * zero/negative length — covers self-edges (a→a) and overlapping cards,
 * which the data layer legitimately emits (Plan-1 final review).
 * @see docs/specs/v0.4-canvas-mvp.md §11
 */
import type { WorldRect } from './spatial-index'

export interface Segment {
  x1: number
  y1: number
  x2: number
  y2: number
}

/** t at which the ray from a rect's center exits the rect, toward (dx,dy). */
function exitT(r: WorldRect, dx: number, dy: number): number {
  const tx = dx === 0 ? Number.POSITIVE_INFINITY : r.w / 2 / Math.abs(dx)
  const ty = dy === 0 ? Number.POSITIVE_INFINITY : r.h / 2 / Math.abs(dy)
  return Math.min(tx, ty)
}

export function edgeSegment(from: WorldRect, to: WorldRect): Segment | null {
  const c1 = { x: from.x + from.w / 2, y: from.y + from.h / 2 }
  const c2 = { x: to.x + to.w / 2, y: to.y + to.h / 2 }
  const dx = c2.x - c1.x
  const dy = c2.y - c1.y
  if (dx === 0 && dy === 0) return null
  const t1 = exitT(from, dx, dy)
  const t2 = exitT(to, -dx, -dy)
  if (t1 + t2 >= 1) return null // clipped away: centers inside each other's rects
  return {
    x1: c1.x + dx * t1,
    y1: c1.y + dy * t1,
    x2: c2.x - dx * t2,
    y2: c2.y - dy * t2,
  }
}
