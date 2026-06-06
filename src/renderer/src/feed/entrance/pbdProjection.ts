/**
 * Up-only, bottom→top non-overlap projection for the wave. `offsets` are the per-row `--wy`
 * offsets ordered TOP→BOTTOM; the last row (the newcomer) is the pinned anchor (only ever the
 * LOWER of a pair, so it is never pushed). For each adjacent pair the lower offset must be ≥ the
 * upper (rest positions already encode heights), so a negative gap pushes ONLY the upper up;
 * sweeping bottom→top, `passes` times, propagates the shove — the magnet impulse emerges from
 * the constraint. Returns a new array; does not mutate the input.
 * @see src/renderer/src/dev/RevealPlayground.tsx (the proven projection)
 * @see docs/specs/v0.2.2-repulsion-wave.md §Architecture
 */
export function projectNoOverlap(offsets: number[], passes: number): number[] {
  const out = offsets.slice()
  for (let it = 0; it < passes; it++) {
    for (let i = out.length - 2; i >= 0; i--) {
      // noUncheckedIndexedAccess: loop bounds guarantee both indices are in range.
      const lower = out[i + 1] as number
      const upper = out[i] as number
      const gap = lower - upper // want ≥ 0
      if (gap < 0) out[i] = upper + gap // push ONLY the upper up; the lower stays pinned
    }
  }
  return out
}
