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
import { uuidv7 } from 'uuidv7'
import type { CanvasLayoutRow, RecentEntry } from '../../../shared/canvas'
import type { Note, NoteType } from '../../../shared/types'
import type { NoteFrontmatter } from '../../files/frontmatter'
import type { NotesDir } from '../../files/notes-dir'
import { slugFromBody } from '../../text/slug'
import { extractWikilinks } from '../../text/wikilinks'
import { replaceLinksForNote } from './links'
import { getNote } from './notes'
import { appendRevision } from './revisions'

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
 * Unlike placeNote, ON CONFLICT overwrites placed_at verbatim (no COALESCE):
 * restore replays the recorded value, it is not a fresh place.
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

/**
 * Create a note AND place it on the canvas in ONE transaction with ONE
 * timestamp (spec §7). This is the single channel that can satisfy the §2
 * recency rule's 'created' detection: notes.created_at = notes.updated_at =
 * node_layouts.placed_at = created_at, all the same ms. Composing
 * notes:create + canvas:placeNote renderer-side CANNOT (each stamps its own
 * Date.now()). File-first / DB-second, exactly like saveNote.
 * @see docs/specs/v0.4-canvas-mvp.md §7 §2
 * @see src/main/save-note.ts (the create-branch this mirrors)
 */
export function createNoteAt(
  db: DB,
  nd: NotesDir,
  i: Key & { body: string; type: NoteType; x: number; y: number },
): Note {
  const now = Date.now()
  const id = uuidv7()
  const slug = slugFromBody(i.body) || id

  // Dup-slug pre-check (create only) — same rationale as save-note.ts:159.
  if (slug !== id) {
    const collision = db
      .prepare('SELECT 1 FROM notes WHERE slug = ? AND deleted_at IS NULL LIMIT 1')
      .get(slug)
    if (collision) throw new Error(`a note named "${slug}" already exists`)
  }

  const links = extractWikilinks(i.body)
  const fm: NoteFrontmatter = { id, slug, type: i.type, created_at: now, updated_at: now }

  // 1. File first (atomic tmp + fsync + rename).
  nd.writeNote(fm, i.body)

  // 2. DB second — notes + links + revision + the placed layout row, one txn,
  //    one `now` (so created_at = updated_at = placed_at).
  return db.transaction(() => {
    db.prepare(
      `INSERT INTO notes (id, slug, body, type, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, slug, i.body, i.type, now, now)
    db.prepare(
      `INSERT INTO node_layouts
         (canvas_id, arrangement_id, note_id, x, y, created_at, placed_at, updated_at)
       VALUES (@canvasId, @arrangementId, @noteId, @x, @y, @now, @now, @now)`,
    ).run({ canvasId: i.canvasId, arrangementId: i.arrangementId, noteId: id, x: i.x, y: i.y, now })
    replaceLinksForNote(db, id, links)
    appendRevision(db, { revisionId: uuidv7(), noteId: id, body: i.body, type: i.type })
    // Non-null: we just inserted it.
    return getNote(db, id) as Note
  })()
}
