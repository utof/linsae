/**
 * CRUD query wrappers for the `notes` table.
 *
 * All functions accept an open better-sqlite3 Database instance and are
 * intentionally side-effect-free beyond the DB call — no caching, no singletons.
 * This makes them trivially testable with an in-memory DB.
 *
 * @see docs/specs/v0.1-rolling-feed-and-search.md §Data model
 * @see docs/specs/v0.1-rolling-feed-and-search.md §User-facing surfaces
 * @see src/main/db/migrations/0001_init.sql
 */

import type Database from 'better-sqlite3'
import type { Note, NoteType, SourceLocator } from '../../../shared/types'

type DB = Database.Database

interface CreateNoteInput {
  id: string
  slug: string
  body: string
  type: NoteType
}

interface UpdateNoteInput {
  id: string
  body: string
  type: NoteType
}

/**
 * Inserts a new note row and returns the fully-hydrated Note record.
 *
 * `created_at` and `updated_at` are both set to `Date.now()` at call time.
 * The FTS5 trigger in 0001_init.sql (`notes_ai`) automatically indexes the body.
 *
 * @param db - Open better-sqlite3 Database.
 * @param input - Note fields required for insertion.
 * @returns The persisted Note (round-tripped via `getNote`).
 * @see docs/specs/v0.1-rolling-feed-and-search.md §Data model
 */
export function createNote(db: DB, input: CreateNoteInput): Note {
  const now = Date.now()
  db.prepare(
    `INSERT INTO notes (id, slug, body, type, created_at, updated_at)
     VALUES (@id, @slug, @body, @type, @created_at, @updated_at)`,
  ).run({ ...input, created_at: now, updated_at: now })
  // Non-null assertion: we just inserted, so the row must exist.
  // Why: getNote returns null for missing rows; a missing row here would be
  // a DB constraint violation that would have already thrown above.
  return getNote(db, input.id)!
}

/**
 * Retrieves a single note by primary key, including soft-deleted rows.
 *
 * Soft-deleted notes are deliberately returned so callers that resolve
 * backlinks can still display historical context.
 *
 * @param db - Open better-sqlite3 Database.
 * @param id - UUID primary key of the note.
 * @returns The Note, or `null` if no row with that id exists.
 * @see docs/specs/v0.1-rolling-feed-and-search.md §Data model
 */
export function getNote(db: DB, id: string): Note | null {
  const row = db
    .prepare(
      `SELECT id, slug, body, type, created_at, updated_at, deleted_at, source_kind, source_locator
       FROM notes WHERE id = ?`,
    )
    .get(id) as (Omit<Note, 'source_locator'> & { source_locator: string | null }) | undefined
  if (!row) return null
  return {
    ...row,
    source_locator: row.source_locator ? (JSON.parse(row.source_locator) as SourceLocator) : null,
  }
}

/**
 * Returns a page of the MOST RECENT non-deleted notes, oldest-first.
 *
 * Why most-recent (not oldest): the rolling feed shows newest at the bottom and
 * the user is always adding new notes there. The query fetches the newest `limit`
 * rows (`created_at DESC LIMIT`) so a freshly-created note is ALWAYS in the page
 * even once the table exceeds `limit`, then reverses to oldest-first for the
 * feed's top→bottom order. The previous `created_at ASC LIMIT` returned the
 * OLDEST `limit` rows, so once you had more than `limit` (default 100) notes,
 * every new note silently vanished from the feed — created in the DB but never
 * listed (issue #20: scroll-back to older history is still pending).
 *
 * `rowid DESC` tiebreaker ensures deterministic ordering when two notes share
 * the same millisecond timestamp (common on fast machines in tests).
 *
 * Cursor-based pagination: supply `before` to fetch the most-recent notes created
 * strictly before that Unix-ms timestamp (the previous page when scrolling up).
 *
 * @param db - Open better-sqlite3 Database.
 * @param opts.limit - Maximum rows to return (the newest this many).
 * @param opts.before - Optional cursor: only return notes with `created_at < before`.
 * @returns Array of Notes, oldest first.
 * @see docs/specs/v0.1-rolling-feed-and-search.md §User-facing surfaces
 */
export function listNotes(db: DB, opts: { limit: number; before?: number }): Note[] {
  // Use `!== undefined` so `before: 0` (valid epoch cursor) doesn't get treated as "no cursor".
  const where =
    opts.before !== undefined
      ? 'WHERE deleted_at IS NULL AND created_at < ?'
      : 'WHERE deleted_at IS NULL'
  const params = opts.before !== undefined ? [opts.before, opts.limit] : [opts.limit]
  const rows = db
    .prepare(
      `SELECT id, slug, body, type, created_at, updated_at, deleted_at, source_kind, source_locator
       FROM notes ${where}
       ORDER BY created_at DESC, rowid DESC
       LIMIT ?`,
    )
    .all(...params) as (Omit<Note, 'source_locator'> & { source_locator: string | null })[]
  // Fetched newest-first for the LIMIT; reverse to oldest-first for the feed.
  rows.reverse()
  return rows.map((row) => ({
    ...row,
    source_locator: row.source_locator ? (JSON.parse(row.source_locator) as SourceLocator) : null,
  }))
}

/**
 * Updates `body`, `type`, and `updated_at` for an existing note.
 *
 * The FTS5 trigger in 0001_init.sql (`notes_au`) automatically re-indexes
 * the updated body.
 *
 * @param db - Open better-sqlite3 Database.
 * @param input - Note id plus the mutable fields to overwrite.
 * @returns The updated Note (round-tripped via `getNote`).
 * @see docs/specs/v0.1-rolling-feed-and-search.md §Data model
 */
export function updateNote(db: DB, input: UpdateNoteInput): Note {
  const now = Date.now()
  db.prepare(
    `UPDATE notes
     SET body = @body, type = @type, updated_at = @updated_at
     WHERE id = @id`,
  ).run({ ...input, updated_at: now })
  // Non-null assertion: caller must pass an existing id.
  // Why: a missing row produces a no-op UPDATE (changes() === 0) with no error;
  // callers that need to detect "not found" should call getNote first.
  return getNote(db, input.id)!
}

/**
 * Marks a note as deleted by setting `deleted_at` to the current Unix-ms timestamp.
 *
 * Soft delete only — the row is never removed. `listNotes` filters deleted rows,
 * but `getNote` still returns them so backlink history remains resolvable.
 *
 * @param db - Open better-sqlite3 Database.
 * @param id - UUID primary key of the note to soft-delete.
 * @see docs/specs/v0.1-rolling-feed-and-search.md §Data model
 */
export function softDeleteNote(db: DB, id: string): void {
  db.prepare('UPDATE notes SET deleted_at = ? WHERE id = ?').run(Date.now(), id)
}
