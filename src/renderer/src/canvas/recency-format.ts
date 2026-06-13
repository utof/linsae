/**
 * Format a RecentEntry for the recent popover (spec §14): a kind prefix plus a
 * compact relative age. Pure — `now` is injected so tests are deterministic.
 * @see docs/specs/v0.4-canvas-mvp.md §14
 */
import type { RecentEntry } from '../../../shared/canvas'

const PREFIX: Record<RecentEntry['kind'], string> = {
  created: 'created here',
  edited: 'edited',
  placed: 'placed',
}

/** Compact relative age: `now` / `2m` / `1h` / `3d`. */
function age(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return 'now'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  return `${Math.floor(h / 24)}d`
}

export function recentLabel(entry: RecentEntry, now: number = Date.now()): string {
  return `${PREFIX[entry.kind]} · ${age(now - entry.at)}`
}
