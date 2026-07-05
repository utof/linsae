import type { z } from 'zod'
import type { FeedScrollV1Schema } from '../../../shared/zod-schemas'

type Restore = z.infer<typeof FeedScrollV1Schema>
export type FeedRestore =
  | { mode: 'seed'; initialMeasurementsCache: Restore['snapshot']; initialOffset: number }
  | { mode: 'index'; index: number }
  | { mode: 'bottom' }
  | { mode: 'default' }

/** Choose how to restore feed scroll, in the render body so a stale cache is never
 *  seeded. Primary: exact seed when persisted indices still map to the same note ids.
 *  @see docs/specs/v0.7-session-persistence.md §Feed scroll */
export function pickFeedRestore(r: Restore | null, noteIds: string[]): FeedRestore {
  if (!r) return { mode: 'default' }
  if (r.anchor?.atEnd) return { mode: 'bottom' }
  const indicesMatch =
    r.snapshot.length > 0 && r.snapshot.every((it) => noteIds[it.index] === it.key)
  if (indicesMatch)
    return { mode: 'seed', initialMeasurementsCache: r.snapshot, initialOffset: r.offset }
  const idx = r.anchor ? noteIds.indexOf(r.anchor.key) : -1
  return idx >= 0 ? { mode: 'index', index: idx } : { mode: 'default' }
}
