/**
 * Edge segment between two cards: anchored center-to-center, clipped at
 * card bounds (spec §11). Returns null when the clipped segment would be
 * zero/negative length — covers self-edges (a→a) and overlapping cards,
 * which the data layer legitimately emits (Plan-1 final review).
 * @see docs/specs/v0.4-canvas-mvp.md §11
 */
import type { CanvasEdge } from '../../../shared/canvas'
import { isDrawnEdge } from './edge-style'
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
  if (t1 + t2 >= 1) return null // clipped exit points cross — overlapping or mutually-engulfed rects
  return {
    x1: c1.x + dx * t1,
    y1: c1.y + dy * t1,
    x2: c2.x - dx * t2,
    y2: c2.y - dy * t2,
  }
}

/** Distance from a world point to the nearest point on a segment (spec §5 hit-test). */
export function pointToSegmentDistance(p: { x: number; y: number }, s: Segment): number {
  const dx = s.x2 - s.x1
  const dy = s.y2 - s.y1
  const lenSq = dx * dx + dy * dy
  if (lenSq === 0) return Math.hypot(p.x - s.x1, p.y - s.y1)
  let t = ((p.x - s.x1) * dx + (p.y - s.y1) * dy) / lenSq
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(p.x - (s.x1 + t * dx), p.y - (s.y1 + t * dy))
}

/** Barb geometry for a directed edge's arrowhead. */
export interface Arrowhead {
  tip: { x: number; y: number }
  left: { x: number; y: number }
  right: { x: number; y: number }
}

/** Two barb points behind the target tip, for a directed drawn edge (spec §6). `size` in world px. */
export function arrowhead(s: Segment, size: number): Arrowhead {
  const dx = s.x2 - s.x1
  const dy = s.y2 - s.y1
  const len = Math.hypot(dx, dy) || 1
  const ux = dx / len
  const uy = dy / len // unit along the segment toward the tip
  const back = size
  const spread = size * 0.6 // barb half-width ≈ 0.6× the back-offset (visual constant)
  const bx = s.x2 - ux * back
  const by = s.y2 - uy * back
  // perpendicular = (-uy, ux)
  return {
    tip: { x: s.x2, y: s.y2 },
    left: { x: bx - uy * spread, y: by + ux * spread },
    right: { x: bx + uy * spread, y: by - ux * spread },
  }
}

/**
 * Nearest DRAWN edge to a world point, within `threshold` world units, else null
 * (spec §5 selection hit-test). Composes {@link edgeSegment} (clip at card bounds)
 * + {@link pointToSegmentDistance} over the edge list, skipping:
 *   - non-drawn edges ({@link isDrawnEdge} false): 'reference'/'comment-on' are
 *     read-only on the canvas and never selectable (decision 6, drawn-only);
 *   - edges whose endpoints aren't BOTH placed (`rectByNoteId` miss): a dangling
 *     edge draws nothing, so it isn't selectable either (spec §11/§1).
 * Pure (no canvas/DOM) so the hit-test math is unit-testable; the pointer→select
 * choreography is smoke-tested (#131).
 * @see docs/specs/v0.4.1-canvas-edges.md §5
 */
export function nearestDrawnEdge(
  point: { x: number; y: number },
  edges: ReadonlyArray<CanvasEdge>,
  rectByNoteId: ReadonlyMap<string, WorldRect>,
  threshold: number,
): CanvasEdge | null {
  let best: CanvasEdge | null = null
  let bestDist = threshold
  for (const edge of edges) {
    if (!isDrawnEdge(edge.edgeType)) continue
    const fromRect = rectByNoteId.get(edge.fromNoteId)
    const toRect = rectByNoteId.get(edge.toNoteId)
    if (!fromRect || !toRect) continue
    const seg = edgeSegment(fromRect, toRect)
    if (!seg) continue
    const d = pointToSegmentDistance(point, seg)
    if (d <= bestDist) {
      bestDist = d
      best = edge
    }
  }
  return best
}
