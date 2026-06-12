/**
 * Canvas constants + shared types. canvas_id/arrangement_id are OPAQUE TEXT
 * keys (vision principles 3-4): 'root' today, a note id when threads arrive;
 * 'manual' today, command-generated arrangements later. Every canvas IPC call
 * and query passes these explicitly — no implicit defaults outside this file.
 * Types are appended task-by-task as consumers appear (knip discipline).
 * @see docs/canvas-vision.md §Locked principles 3-4
 * @see docs/specs/v0.4-canvas-mvp.md §2
 */
export const ROOT_CANVAS_ID = 'root'
export const MANUAL_ARRANGEMENT_ID = 'manual'

/** One node_layouts row. x/y are world coords; both-null = shelved.
 * @see docs/specs/v0.4-canvas-mvp.md §1 */
export interface CanvasLayoutRow {
  canvas_id: string
  arrangement_id: string
  note_id: string
  x: number | null
  y: number | null
  created_at: number
  placed_at: number | null
  updated_at: number
}

/** Recent-popover entry (spec §2 recency rule).
 * @see docs/specs/v0.4-canvas-mvp.md §2 */
export interface RecentEntry {
  noteId: string
  kind: 'edited' | 'placed' | 'created'
  at: number
}
