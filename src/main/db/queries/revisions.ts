/**
 * Query wrappers for the `note_revisions` table — append-only history of
 * every saved note version, with a `supersedes` self-FK forming a linked
 * list per note.
 *
 * All functions accept an open better-sqlite3 Database and are side-effect
 * free beyond the DB call, mirroring the pattern in `./notes.ts` and
 * `./links.ts`.
 *
 * @see docs/specs/v0.1-rolling-feed-and-search.md §Data model (note_revisions)
 * @see docs/specs/v0.1-rolling-feed-and-search.md §Write atomicity (per save)
 * @see src/main/db/migrations/0001_init.sql (note_revisions, idx_note_revisions_note)
 */

import type Database from 'better-sqlite3'
import type { NoteType } from '../../../shared/types'

type DB = Database.Database

/**
 * One persisted revision of a note. Mirrors the `note_revisions` row shape
 * verbatim (snake_case timestamps to match `Note`).
 *
 * `supersedes` is the previous revision's id, or null for the first revision
 * of a note. The chain lets future surfaces (v0.2 edit-history pane) walk
 * versions backwards without re-querying.
 *
 * Why a chain instead of an ORDER BY saved_at lookup: monotonic timestamps
 * can collide on fast machines (notes.ts uses a rowid tiebreaker); an
 * explicit linked list survives clock skew and is the v0.2 surface contract
 * per spec §note_revisions intent.
 *
 * @see docs/specs/v0.1-rolling-feed-and-search.md §Data model (note_revisions)
 */
export interface Revision {
  id: string
  note_id: string
  body: string
  type: NoteType
  saved_at: number
  supersedes: string | null
}

/**
 * Appends a new revision row for `input.noteId`, linking `supersedes` to the
 * prior most-recent revision of that note (or null if this is the first).
 *
 * The lookup + insert run inside a `db.transaction` so a concurrent
 * `appendRevision` for the same note can never see a torn state where two
 * fresh rows both point at the same predecessor.
 *
 * Why return the full Revision (not just an id): callers writing a save
 * pipeline already have the body/type in hand; round-tripping via a separate
 * `getRevision` would be an extra query for no gain.
 *
 * @param db - Open better-sqlite3 Database.
 * @param input.revisionId - UUIDv7 for the new row's primary key.
 * @param input.noteId - The owning note's id (FK into `notes.id`).
 * @param input.body - The body text at this revision.
 * @param input.type - The note type at this revision.
 * @returns The persisted Revision including the resolved `supersedes` pointer.
 * @see docs/specs/v0.1-rolling-feed-and-search.md §Write atomicity (per save) step 4
 */
export function appendRevision(
  db: DB,
  input: { revisionId: string; noteId: string; body: string; type: NoteType },
): Revision {
  const now = Date.now()
  let supersedes: string | null = null
  const tx = db.transaction(() => {
    const prev = db
      .prepare('SELECT id FROM note_revisions WHERE note_id = ? ORDER BY saved_at DESC LIMIT 1')
      .get(input.noteId) as { id: string } | undefined
    supersedes = prev?.id ?? null
    db.prepare(
      `INSERT INTO note_revisions (id, note_id, body, type, saved_at, supersedes)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(input.revisionId, input.noteId, input.body, input.type, now, supersedes)
  })
  tx()
  return {
    id: input.revisionId,
    note_id: input.noteId,
    body: input.body,
    type: input.type,
    saved_at: now,
    supersedes,
  }
}

/**
 * Returns every revision of `noteId`, newest first.
 *
 * Ordering matches the v0.2 edit-history pane contract: most recent at the
 * top, walking back through the `supersedes` chain. The
 * `idx_note_revisions_note(note_id, saved_at)` index makes this O(log n + k).
 *
 * `rowid DESC` tiebreaker: two appends in the same millisecond (common on fast
 * machines / in tests) would otherwise tie on `saved_at` and order is
 * implementation-defined. SQLite assigns rowid in insertion order, so the
 * later append always sorts first. Matches the `listNotes` pattern in notes.ts.
 *
 * @param db - Open better-sqlite3 Database.
 * @param noteId - The owning note's id.
 * @returns Revisions ordered by `saved_at DESC, rowid DESC` (newest first); empty if none.
 * @see docs/specs/v0.1-rolling-feed-and-search.md §Data model (note_revisions)
 */
export function listRevisions(db: DB, noteId: string): Revision[] {
  return db
    .prepare(
      `SELECT id, note_id, body, type, saved_at, supersedes
       FROM note_revisions
       WHERE note_id = ?
       ORDER BY saved_at DESC, rowid DESC`,
    )
    .all(noteId) as Revision[]
}
