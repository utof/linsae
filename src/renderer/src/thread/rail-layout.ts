/**
 * Pure layout math for the Thread rail, scrubber, and jump-pill.
 *
 * All functions are side-effect free and DOM-independent — safe for unit tests
 * and for use in both the main thread and worker contexts.
 *
 * @see docs/specs/v0.2-youtube-annotation.md §ThreadView
 */

// ---------------------------------------------------------------------------
// Local types — NOT exported (knip: exported types with test-only consumers
// would fail the precommit knip step; component consumers added in later tasks)
// ---------------------------------------------------------------------------

interface ThreadNote {
  id: string
  t: number | null
  createdAt: number
}

type SortMode = 'video' | 'capture'

interface NoteCluster {
  t: number
  notes: ThreadNote[]
}

interface JumpPillInput {
  mode: SortMode
  followOn: boolean
  playheadY: number
  viewTop: number
  viewBottom: number
}

// ---------------------------------------------------------------------------
// Exported functions
// ---------------------------------------------------------------------------

/**
 * Height in pixels for a visual gap representing `min` minutes between notes.
 * Uses a logarithmic curve so very long gaps don't dominate the rail.
 *
 * Formula: `round(20 + 9 · ln(1 + min))`
 *
 * @see docs/specs/v0.2-youtube-annotation.md §ThreadView (spec line ~203)
 */
export function logGapHeight(min: number): number {
  return Math.round(20 + 9 * Math.log(1 + min))
}

/**
 * Splits a list of notes into anchored (t !== null) and anchorless (t === null)
 * buckets, preserving original order within each bucket.
 *
 * @see docs/specs/v0.2-youtube-annotation.md §ThreadView
 */
export function partitionAnchorless(notes: ThreadNote[]): {
  anchored: ThreadNote[]
  anchorless: ThreadNote[]
} {
  const anchored: ThreadNote[] = []
  const anchorless: ThreadNote[] = []
  for (const note of notes) {
    if (note.t !== null) {
      anchored.push(note)
    } else {
      anchorless.push(note)
    }
  }
  return { anchored, anchorless }
}

/**
 * Groups anchored notes by identical `t` value into clusters sorted by `t` asc.
 * Notes with a null `t` are silently dropped — callers should pass anchored notes only.
 *
 * Same-pause equality is exact `t` match (sufficient at v0.2.0 granularity).
 *
 * @see docs/specs/v0.2-youtube-annotation.md §ThreadView
 */
export function clusterByPause(notes: ThreadNote[]): NoteCluster[] {
  const anchored = notes.filter((n): n is ThreadNote & { t: number } => n.t !== null)
  const sorted = [...anchored].sort((a, b) => a.t - b.t)

  const clusters: NoteCluster[] = []
  for (const note of sorted) {
    const last = clusters[clusters.length - 1]
    if (last !== undefined && last.t === note.t) {
      last.notes.push(note)
    } else {
      clusters.push({ t: note.t, notes: [note] })
    }
  }
  return clusters
}

/**
 * Returns notes sorted for display according to `mode`:
 * - `'video'`: anchored notes sorted by `t` asc, then anchorless sorted by `createdAt` asc.
 * - `'capture'`: all notes sorted by `createdAt` asc regardless of anchor status.
 *
 * Does NOT mutate the input array.
 *
 * @see docs/specs/v0.2-youtube-annotation.md §ThreadView
 */
export function sortForMode(notes: ThreadNote[], mode: SortMode): ThreadNote[] {
  if (mode === 'capture') {
    return [...notes].sort((a, b) => a.createdAt - b.createdAt)
  }
  // 'video' mode
  const { anchored, anchorless } = partitionAnchorless(notes)
  const sortedAnchored = [...anchored].sort((a, b) => (a.t as number) - (b.t as number))
  const sortedAnchorless = [...anchorless].sort((a, b) => a.createdAt - b.createdAt)
  return [...sortedAnchored, ...sortedAnchorless]
}

/**
 * Computes scrubber marker positions for unique anchored timestamps as a
 * percentage of `duration`.
 *
 * Returns `[]` when `duration` is null or ≤ 0.
 *
 * @see docs/specs/v0.2-youtube-annotation.md §ThreadView
 */
export function markerPositions(
  notes: ThreadNote[],
  duration: number | null,
): { t: number; pct: number }[] {
  if (duration === null || duration <= 0) return []

  const seen = new Set<number>()
  const unique: number[] = []
  for (const note of notes) {
    if (note.t !== null && !seen.has(note.t)) {
      seen.add(note.t)
      unique.push(note.t)
    }
  }
  unique.sort((a, b) => a - b)
  return unique.map((t) => ({ t, pct: (t / duration) * 100 }))
}

/**
 * Returns `true` when the jump-to-playhead pill should be visible.
 *
 * Conditions (all must hold): `mode === 'video'`, `followOn === false`, and
 * the playhead pixel position is outside the visible viewport by more than 8 px.
 *
 * @see docs/specs/v0.2-youtube-annotation.md §ThreadView
 */
export function jumpPillVisible(input: JumpPillInput): boolean {
  const { mode, followOn, playheadY, viewTop, viewBottom } = input
  return mode === 'video' && !followOn && (playheadY < viewTop + 8 || playheadY > viewBottom - 8)
}
