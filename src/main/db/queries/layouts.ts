/**
 * Query wrappers for `node_layouts` — the canvas position/shelf store.
 *
 * Positions are VIEW-STATE (vision principle 2): nothing here touches note
 * content. Every write except removeNotes re-checks note liveness
 * (`deleted_at IS NULL`) in its statement and silently skips dead notes
 * (spec §2) — a layout row for a soft-deleted note is a bug, not a tombstone
 * (spec §1); removeNotes is deliberately unguarded because deleting rows is
 * the cleanup direction.
 *
 * @see docs/specs/v0.4-canvas-mvp.md §1 §2
 * @see docs/canvas-vision.md §Locked principles 2-4
 */
import type Database from 'better-sqlite3'
import type { CanvasLayoutRow, RecentEntry } from '../../../shared/canvas'

type DB = Database.Database

interface Key {
  canvasId: string
  arrangementId: string
}

const LIVE = `EXISTS (SELECT 1 FROM notes n WHERE n.id = @noteId AND n.deleted_at IS NULL)`

/**
 * All layout rows (placed + shelved) for a canvas/arrangement, live notes only.
 * Why: one query; the renderer splits placed/shelved on `x IS NULL` (spec §2).
 * rowid tiebreaker: same-ms created_at rows must order deterministically.
 * @see docs/specs/v0.4-canvas-mvp.md §2
 */
export function listLayouts(db: DB, k: Key): CanvasLayoutRow[] {
  return db
    .prepare(
      `SELECT l.canvas_id, l.arrangement_id, l.note_id, l.x, l.y,
              l.created_at, l.placed_at, l.updated_at
       FROM node_layouts l JOIN notes n ON n.id = l.note_id AND n.deleted_at IS NULL
       WHERE l.canvas_id = @canvasId AND l.arrangement_id = @arrangementId
       ORDER BY l.created_at, l.rowid`,
    )
    .all(k) as CanvasLayoutRow[]
}

/**
 * Queue a note on the shelf. INSERT OR IGNORE: a second shelve — or shelving
 * an already-placed note — is a no-op. Skips dead notes.
 * @see docs/specs/v0.4-canvas-mvp.md §2
 */
export function shelveNote(db: DB, i: Key & { noteId: string }): void {
  const now = Date.now()
  db.prepare(
    `INSERT OR IGNORE INTO node_layouts
       (canvas_id, arrangement_id, note_id, x, y, created_at, placed_at, updated_at)
     SELECT @canvasId, @arrangementId, @noteId, NULL, NULL, @now, NULL, @now
     WHERE ${LIVE}`,
  ).run({ ...i, now })
}

/**
 * Place (or re-place) a note at world (x, y). Upserts shelved→placed and
 * fresh-place alike; `placed_at` is stamped only when currently NULL so the
 * shelf's "recently placed" ordering and the recency rule stay stable.
 * @see docs/specs/v0.4-canvas-mvp.md §2
 */
export function placeNote(db: DB, i: Key & { noteId: string; x: number; y: number }): void {
  const now = Date.now()
  db.prepare(
    `INSERT INTO node_layouts
       (canvas_id, arrangement_id, note_id, x, y, created_at, placed_at, updated_at)
     SELECT @canvasId, @arrangementId, @noteId, @x, @y, @now, @now, @now
     WHERE ${LIVE}
     ON CONFLICT (canvas_id, arrangement_id, note_id) DO UPDATE SET
       x = excluded.x, y = excluded.y,
       placed_at = COALESCE(node_layouts.placed_at, excluded.placed_at),
       updated_at = excluded.updated_at`,
  ).run({ ...i, now })
}

/**
 * Batch position update (group drag, nudge). One transaction; move-semantics:
 * only rows that are already placed move — shelved rows are ignored.
 * @see docs/specs/v0.4-canvas-mvp.md §2
 */
export function moveNotes(
  db: DB,
  i: Key & { moves: { noteId: string; x: number; y: number }[] },
): void {
  const now = Date.now()
  const stmt = db.prepare(
    `UPDATE node_layouts SET x = @x, y = @y, updated_at = @now
     WHERE canvas_id = @canvasId AND arrangement_id = @arrangementId
       AND note_id = @noteId AND x IS NOT NULL AND ${LIVE}`,
  )
  const run = db.transaction((moves: { noteId: string; x: number; y: number }[]) => {
    for (const m of moves)
      stmt.run({ ...m, canvasId: i.canvasId, arrangementId: i.arrangementId, now })
  })
  run(i.moves)
}

/**
 * Back to the shelf: x/y AND placed_at → NULL (an undo-reshelved row re-enters
 * "to place" and leaves "recently placed"). Used by undo-of-place.
 * @see docs/specs/v0.4-canvas-mvp.md §2 §4
 */
export function unplaceNotes(db: DB, i: Key & { noteIds: string[] }): void {
  const now = Date.now()
  const stmt = db.prepare(
    `UPDATE node_layouts SET x = NULL, y = NULL, placed_at = NULL, updated_at = @now
     WHERE canvas_id = @canvasId AND arrangement_id = @arrangementId AND note_id = @noteId
       AND ${LIVE}`,
  )
  const run = db.transaction((ids: string[]) => {
    for (const noteId of ids)
      stmt.run({ noteId, canvasId: i.canvasId, arrangementId: i.arrangementId, now })
  })
  run(i.noteIds)
}

/**
 * Delete layout rows (remove-from-canvas verb). One transaction.
 * Why: deliberately NO liveness guard — deleting rows is the cleanup
 * direction; guarding would strand rows for dead notes (spec §1).
 * @see docs/specs/v0.4-canvas-mvp.md §2 §8
 */
export function removeNotes(db: DB, i: Key & { noteIds: string[] }): void {
  const stmt = db.prepare(
    `DELETE FROM node_layouts
     WHERE canvas_id = @canvasId AND arrangement_id = @arrangementId AND note_id = @noteId`,
  )
  const run = db.transaction((ids: string[]) => {
    for (const noteId of ids)
      stmt.run({ noteId, canvasId: i.canvasId, arrangementId: i.arrangementId })
  })
  run(i.noteIds)
}

interface RestoreRow {
  noteId: string
  x: number | null
  y: number | null
  createdAt: number
  placedAt: number | null
}

/**
 * Undo-of-remove: full-row upsert preserving original timestamps.
 * Skips notes deleted since the entry was recorded — a stale undo must never
 * resurrect layout rows for a dead note.
 * @see docs/specs/v0.4-canvas-mvp.md §2 §13
 */
export function restoreLayouts(db: DB, i: Key & { rows: RestoreRow[] }): void {
  const now = Date.now()
  const stmt = db.prepare(
    `INSERT INTO node_layouts
       (canvas_id, arrangement_id, note_id, x, y, created_at, placed_at, updated_at)
     SELECT @canvasId, @arrangementId, @noteId, @x, @y, @createdAt, @placedAt, @now
     WHERE ${LIVE}
     ON CONFLICT (canvas_id, arrangement_id, note_id) DO UPDATE SET
       x = excluded.x, y = excluded.y, placed_at = excluded.placed_at,
       updated_at = excluded.updated_at`,
  )
  const run = db.transaction((rows: typeof i.rows) => {
    for (const r of rows)
      stmt.run({ ...r, canvasId: i.canvasId, arrangementId: i.arrangementId, now })
  })
  run(i.rows)
}

/**
 * Purge a note's layout rows across ALL canvases/arrangements.
 * Why: called from the softDelete path (save-note.ts) — spec §1.
 */
export function deleteLayoutsForNote(db: DB, noteId: string): void {
  db.prepare(`DELETE FROM node_layouts WHERE note_id = ?`).run(noteId)
}

/**
 * Recent-popover feed: at = max(updated_at, placed_at); kind 'created' iff
 * created_at = updated_at = placed_at (the §7 creation transaction stamps all
 * three with one millisecond value), else 'edited' if updated_at is the max,
 * else 'placed'.
 * @see docs/specs/v0.4-canvas-mvp.md §2 (recency rule) §14
 */
export function recentOnCanvas(db: DB, i: Key & { limit: number }): RecentEntry[] {
  return db
    .prepare(
      `SELECT l.note_id AS noteId,
              MAX(n.updated_at, COALESCE(l.placed_at, 0)) AS at,
              CASE
                WHEN n.created_at = n.updated_at AND n.updated_at = l.placed_at THEN 'created'
                WHEN n.updated_at >= COALESCE(l.placed_at, 0) THEN 'edited'
                ELSE 'placed'
              END AS kind
       FROM node_layouts l JOIN notes n ON n.id = l.note_id AND n.deleted_at IS NULL
       WHERE l.canvas_id = @canvasId AND l.arrangement_id = @arrangementId AND l.x IS NOT NULL
       ORDER BY at DESC LIMIT @limit`,
    )
    .all(i) as RecentEntry[]
}
