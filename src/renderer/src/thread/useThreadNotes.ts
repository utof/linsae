/**
 * Hook that fetches a video-note's comment-on-linked notes and derives the
 * layout inputs for the thread Rail and ThreadView.
 *
 * The query is keyed on `['thread', videoNoteId, sortMode]` so switching sort
 * mode invalidates nothing but re-sorts the cached data locally — no extra
 * network / IPC round-trip.
 *
 * Why derive thread items inside the hook (not in components): `sortForMode`,
 * `clusterByPause`, and `partitionAnchorless` are pure functions; doing the
 * derivation here keeps the component tree thin and makes the logic testable
 * with `renderHook`.
 *
 * `openQuestionCount` = notes where `type === 'question'`. There is no
 * "answered / resolved" concept in the notes table at v0.2.0 — status pills
 * are deferred to v0.3+ per CLAUDE.md §Stack. The v0.2 spec (line 111)
 * says "open-question count … reusing v0.1 question/status semantics (no new
 * concept here)", and v0.1 never shipped a resolved state to the notes table.
 *
 * @issue utof/linsae#36
 * @see src/renderer/src/thread/rail-layout.ts
 * @see docs/specs/v0.2-youtube-annotation.md §ThreadView
 */

import { useQuery } from '@tanstack/react-query'
import type { Attachment, Note } from '../../../shared/types'
import { api } from '../lib/api'
import { clusterByPause, partitionAnchorless, sortForMode } from './rail-layout'

type SortMode = 'video' | 'capture'

/**
 * A thread item fed to `sortForMode` / `clusterByPause`. Extra fields are preserved.
 *
 * Why not exported: no non-test consumer yet. Export when a component imports this
 * type (knip enforces that all exported symbols have a non-test consumer).
 */
interface ThreadItem {
  id: string
  t: number | null
  createdAt: number
  note: Note
  attachment: Attachment | null
}

/**
 * A cluster of anchored `ThreadItem`s at the same timestamp.
 * Mirrors the shape returned by `clusterByPause` but with `notes` typed as
 * `ThreadItem[]` so callers get the full `note`/`attachment` fields.
 *
 * Why not exported: no non-test consumer yet. Export when a component imports this
 * type.
 */
interface ThreadItemCluster {
  t: number
  notes: ThreadItem[]
}

/** Return shape of `useThreadNotes`. */
export interface UseThreadNotesResult {
  /** Notes sorted for the active `sortMode`. */
  sorted: ThreadItem[]
  /** Anchored notes clustered by identical `t` (for rail rendering). */
  clusters: ThreadItemCluster[]
  /** Notes with no timestamp (rendered below the rail). */
  anchorless: ThreadItem[]
  /** Total comment-note count. */
  noteCount: number
  /**
   * Notes with `type === 'question'` (all questions are "open" at v0.2.0;
   * no resolved/answered state exists in the schema yet).
   * Why: spec line 111 says reuse v0.1 question/status semantics; v0.1 never
   * shipped a resolved state — `type === 'question'` is the only signal.
   */
  openQuestionCount: number
  isLoading: boolean
}

/**
 * Fetches comment-notes for `videoNoteId` and derives sorted/clustered layout
 * data for the given `sortMode`.
 *
 * @param videoNoteId - The video-note's UUID (passed to `api.links.commentsOf`).
 * @param sortMode - `'video'` (by timestamp then createdAt) or `'capture'` (by createdAt).
 * @returns Sorted items, clusters, anchorless bucket, counts, and loading state.
 * @issue utof/linsae#36
 * @see src/renderer/src/thread/rail-layout.ts
 */
export function useThreadNotes(videoNoteId: string, sortMode: SortMode): UseThreadNotesResult {
  const { data = [], isLoading } = useQuery({
    queryKey: ['thread', videoNoteId, sortMode],
    queryFn: () => api.links.commentsOf(videoNoteId),
    enabled: !!videoNoteId,
  })

  const items: ThreadItem[] = data.map(({ note, attachment }) => ({
    id: note.id,
    t: note.source_locator?.t ?? null,
    createdAt: note.created_at,
    note,
    attachment,
  }))

  const sorted = sortForMode(items, sortMode) as ThreadItem[]
  const { anchored, anchorless } = partitionAnchorless(items)
  // clusterByPause accepts { id, t, createdAt } structurally; cast the result
  // back to ThreadItemCluster[] since the function preserves object identity
  // (no reconstruction — it pushes existing refs into the clusters array).
  const clusters = clusterByPause(anchored) as unknown as ThreadItemCluster[]

  const noteCount = items.length
  const openQuestionCount = items.filter((i) => i.note.type === 'question').length

  return {
    sorted,
    clusters,
    // partitionAnchorless preserves object identity (no reconstruction);
    // cast to ThreadItem[] so callers get note/attachment fields.
    anchorless: anchorless as unknown as ThreadItem[],
    noteCount,
    openQuestionCount,
    isLoading,
  }
}
