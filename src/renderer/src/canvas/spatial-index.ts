/**
 * Thin wrapper around rbush for placed-card world rects (spec §3 culling;
 * §16: dot-tier hit-testing and ink-stroke culling reuse this module later
 * — keep it card-agnostic in shape, string ids + rects only).
 *
 * Why an internal id→item Map: rbush removes by reference (or a custom
 * equals fn); holding the live item per id makes setCard a correct
 * remove+insert without an equals scan. rbush v4 has NO update() method
 * (verified against the v4.0.1 tarball + README, 2026-06-13).
 * @see docs/specs/v0.4-canvas-mvp.md §3 §16
 */
import RBush from 'rbush'

export interface WorldRect {
  x: number
  y: number
  w: number
  h: number
}

interface IndexedCard {
  minX: number
  minY: number
  maxX: number
  maxY: number
  id: string
}

function toItem(id: string, r: WorldRect): IndexedCard {
  return { id, minX: r.x, minY: r.y, maxX: r.x + r.w, maxY: r.y + r.h }
}

export class CardSpatialIndex {
  private tree = new RBush<IndexedCard>()
  private items = new Map<string, IndexedCard>()

  /** Insert or move one card (remove+insert — the rbush update idiom). */
  setCard(id: string, rect: WorldRect): void {
    const prev = this.items.get(id)
    if (prev) this.tree.remove(prev)
    const item = toItem(id, rect)
    this.items.set(id, item)
    this.tree.insert(item)
  }

  /** Remove one card; absent ids are a no-op. */
  removeCard(id: string): void {
    const prev = this.items.get(id)
    if (!prev) return
    this.tree.remove(prev)
    this.items.delete(id)
  }

  /** Ids of cards intersecting a world rect (the inflated viewport). */
  search(rect: { minX: number; minY: number; maxX: number; maxY: number }): string[] {
    return this.tree.search(rect).map((i) => i.id)
  }

  /** Replace the whole index (layout-list refetch). Bulk load: ~2-3× faster. */
  rebuild(cards: { id: string; rect: WorldRect }[]): void {
    this.tree.clear()
    this.items.clear()
    const items = cards.map((c) => toItem(c.id, c.rect))
    for (const i of items) this.items.set(i.id, i)
    this.tree.load(items)
  }
}
