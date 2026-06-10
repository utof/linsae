/** Minimal row geometry — structurally satisfied by tanstack-virtual's `VirtualItem`. */
export interface RowSpan {
  index: number
  start: number
  end: number
}

/**
 * Indices of rows whose [start, end) span overlaps the y-range between `a`
 * and `b` (content coordinates, either order). Strict inequalities give
 * half-open overlap: a drag whose edge merely touches a row boundary does
 * NOT select that row — without this, every drag would grab one extra
 * neighbour on each side because adjacent rows share a boundary pixel.
 *
 * Why a free function (not inline in the drag hook): the drag→selection
 * mapping is the only geometry logic in the feature, and pure functions are
 * the repo's unit-test surface (CLAUDE.md §Tests every batch).
 *
 * @see docs/plans/v0.2.3-multi-select.md
 */
export function indicesInRange(rows: readonly RowSpan[], a: number, b: number): number[] {
  const top = Math.min(a, b)
  const bottom = Math.max(a, b)
  return rows.filter((r) => r.end > top && r.start < bottom).map((r) => r.index)
}

/**
 * Indices to add for Telegram's "Select up to this message": the contiguous
 * run from the selected index NEAREST to `target`, through `target`,
 * inclusive. Nearest (not last-toggled) because the Feed stores selection as
 * a Set — no toggle order exists — and nearest matches the visual intuition
 * of "bridge the gap to the closest selected note".
 *
 * @see docs/plans/v0.2.3-multi-select.md
 */
export function fillToIndex(selected: readonly number[], target: number): number[] {
  if (selected.length === 0) return [target]
  let nearest = selected[0] as number
  for (const s of selected) {
    if (Math.abs(s - target) < Math.abs(nearest - target)) nearest = s
  }
  const lo = Math.min(nearest, target)
  const hi = Math.max(nearest, target)
  const out: number[] = []
  for (let i = lo; i <= hi; i++) out.push(i)
  return out
}
