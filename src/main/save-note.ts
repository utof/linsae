/**
 * The single save orchestrator that every IPC create/update/softDelete handler
 * calls. Coordinates the file-first / DB-second invariant defined in spec
 * §Storage architecture / §Write atomicity.
 *
 * Why file first, DB second: markdown files on disk are the source of truth;
 * SQLite is a derived index. `nd.writeNote` is crash-safe (atomic tmp + fsync +
 * rename via {@link atomicWriteFile}). The subsequent DB statements run inside
 * a single `db.transaction(...)` for atomicity. If the process dies between
 * the file write and the DB commit, the file on disk wins and the next startup
 * reconciliation re-derives the SQLite row. DB-first would let a crash leave a
 * DB row whose file write never landed, which the reconciler would then mark
 * `deleted_at`, silently destroying the just-saved note.
 *
 * @see docs/specs/v0.1-rolling-feed-and-search.md §Storage architecture
 * @see docs/specs/v0.1-rolling-feed-and-search.md §Write atomicity (per save)
 * @see docs/specs/v0.1-rolling-feed-and-search.md §Soft delete and backlinks
 * @see docs/specs/v0.1-rolling-feed-and-search.md §Stable slug from frontmatter
 * @see docs/plans/v0.1-rolling-feed-and-search.md §Task 18
 */

import type Database from 'better-sqlite3'
import { uuidv7 } from 'uuidv7'
import type { Note, NoteType } from '../shared/types'
import { replaceLinksForNote } from './db/queries/links'
import { getNote } from './db/queries/notes'
import { appendRevision } from './db/queries/revisions'
import type { NoteFrontmatter } from './files/frontmatter'
import type { NotesDir } from './files/notes-dir'
import { slugFromBody } from './text/slug'
import { extractWikilinks } from './text/wikilinks'

type DB = Database.Database

/**
 * Discriminated union describing the three operations the orchestrator
 * supports.
 *
 * Why a tagged union rather than three separate functions: the file-first /
 * DB-second invariant is identical across all three modes (write file, then
 * one DB transaction); a single entry point makes the ordering impossible to
 * forget at call sites and keeps the spec contract reviewable in one place.
 *
 * - `create`     — generate a fresh UUIDv7, derive `slug` from the body's
 *                  first heading / non-empty line via {@link slugFromBody}
 *                  (falling back to the id when the body is empty).
 * - `update`     — keep the existing slug (per spec §Stable slug from
 *                  frontmatter); re-extract wikilinks; append a new revision.
 *                  Throws if `id` does not exist.
 * - `softDelete` — set `deleted_at` and drop all outbound link rows so
 *                  backlinks panes never display "(deleted) note linked here"
 *                  (spec §Soft delete and backlinks). Throws if `id` does not
 *                  exist.
 */
export type SaveInput =
  | { mode: 'create'; body: string; type: NoteType }
  | { mode: 'update'; id: string; body: string; type: NoteType }
  | { mode: 'softDelete'; id: string }

/**
 * Persist a note: file FIRST (atomic tmp+fsync+rename via `nd.writeNote`),
 * then a single SQLite transaction (upsert `notes`, replace `links`, append
 * `note_revisions`).
 *
 * Why: This is the only function any IPC handler should call to mutate notes.
 * See the file-level TSDoc for the invariant rationale. Bypasses
 * `createNote`/`updateNote` in `./db/queries/notes.ts` so a single `now`
 * timestamp is threaded through both the file frontmatter and the DB row
 * (otherwise the queries-layer helpers call `Date.now()` internally, drifting
 * the file/DB clocks by 1+ ms).
 *
 * Update mode also un-soft-deletes: editing a note that was previously
 * soft-deleted clears `deleted_at` from BOTH the frontmatter (via the
 * rest-destructure below) AND the DB row (the inline UPDATE writes
 * `deleted_at = NULL`). Both sides must clear in lockstep — leaving
 * `deleted_at` set on the DB row while the file says "live" would let the
 * reconciler revert the un-delete by trusting the disk file, and the
 * `idx_notes_slug_live` partial unique index (where `deleted_at IS NULL`)
 * would let a new note collide on the same slug.
 *
 * @param db    - Open better-sqlite3 Database.
 * @param nd    - {@link NotesDir} pointed at the user's notes directory.
 * @param input - {@link SaveInput} describing the operation.
 * @returns The persisted {@link Note}, fully hydrated from the DB.
 * @throws If `input.mode` is `update` or `softDelete` and `input.id` is unknown.
 */
export function saveNote(db: DB, nd: NotesDir, input: SaveInput): Note {
  const now = Date.now()

  if (input.mode === 'softDelete') {
    const note = getNote(db, input.id)
    if (!note) throw new Error(`note not found: ${input.id}`)

    // Merge with any existing frontmatter so aliases: and any unknown keys
    // survive the soft-delete write. If the file is malformed or missing,
    // synthesise a fresh frontmatter object from the DB row.
    const existing = nd.readNote(input.id)
    const baseFm: NoteFrontmatter = existing.ok
      ? { ...existing.frontmatter, updated_at: note.updated_at, deleted_at: now }
      : {
          id: note.id,
          slug: note.slug,
          type: note.type,
          created_at: note.created_at,
          updated_at: note.updated_at,
          deleted_at: now,
        }

    // 1. File first (atomic tmp + fsync + rename inside nd.writeNote).
    nd.writeNote(baseFm, note.body)

    // 2. DB second, in one transaction. Drop outbound links per spec §235.
    db.transaction(() => {
      replaceLinksForNote(db, input.id, [])
      db.prepare('UPDATE notes SET deleted_at = ? WHERE id = ?').run(now, input.id)
    })()

    // Non-null assertion: we just confirmed the row exists above and the
    // transaction only updated `deleted_at`.
    return getNote(db, input.id)!
  }

  // create or update
  const id = input.mode === 'create' ? uuidv7() : input.id
  const existing = input.mode === 'update' ? getNote(db, input.id) : null
  if (input.mode === 'update' && !existing) throw new Error(`note not found: ${input.id}`)

  // Why `|| id` fallback: an empty body yields an empty slug from slugFromBody;
  // using the uuidv7 as the slug keeps wikilink resolution well-defined until
  // the user types a first line.
  const slug = input.mode === 'create' ? slugFromBody(input.body) || id : existing!.slug

  // Duplicate-slug pre-check (create only; update preserves the existing slug
  // per spec §Stable slug from frontmatter and therefore cannot collide).
  // Without this, the INSERT below would throw a raw SqliteError after we'd
  // already written the file to disk — leaving an orphan .md that the next
  // reconcile would then skip+log on every startup. Pre-checking lets us
  // throw a user-facing message BEFORE any disk or DB write, so the composer
  // can show an inline error with the user's text + cursor preserved.
  // Single-process Electron + sync better-sqlite3 means no TOCTOU race.
  // @see https://github.com/utof/linsae/issues/23
  if (input.mode === 'create' && slug !== id) {
    const collision = db
      .prepare('SELECT 1 FROM notes WHERE slug = ? AND deleted_at IS NULL LIMIT 1')
      .get(slug)
    if (collision) throw new Error(`a note named "${slug}" already exists`)
  }

  const created_at = input.mode === 'create' ? now : existing!.created_at
  const links = extractWikilinks(input.body)

  // On update, preserve aliases: and any unknown frontmatter keys by reading
  // the existing file and merging. On create, build fresh.
  // Why the rest-destructure: `exactOptionalPropertyTypes` forbids assigning
  // `undefined` to optional fields, so we must build a frontmatter object that
  // simply omits `deleted_at` rather than setting it to undefined (the latter
  // also serialises to `deleted_at: undefined` in YAML on some js-yaml
  // configurations, polluting the file).
  const existingFile = input.mode === 'update' ? nd.readNote(input.id) : null
  let fm: NoteFrontmatter
  if (existingFile?.ok) {
    const { deleted_at: _drop, ...rest } = existingFile.frontmatter
    fm = { ...rest, slug, type: input.type, created_at, updated_at: now }
  } else {
    fm = { id, slug, type: input.type, created_at, updated_at: now }
  }

  // 1. File first.
  nd.writeNote(fm, input.body)

  // 2. DB second, in one transaction.
  // Why inline INSERT/UPDATE rather than calling createNote/updateNote: those
  // helpers call `Date.now()` internally; threading `now` keeps the file
  // frontmatter and DB row timestamps aligned within a single save. Also
  // clears `deleted_at` on update so editing a soft-deleted note un-deletes it.
  const note = db.transaction(() => {
    let n: Note
    if (input.mode === 'create') {
      db.prepare(
        `INSERT INTO notes (id, slug, body, type, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(id, slug, input.body, input.type, created_at, now)
      n = getNote(db, id)!
    } else {
      db.prepare(
        `UPDATE notes SET body = ?, type = ?, updated_at = ?, deleted_at = NULL WHERE id = ?`,
      ).run(input.body, input.type, now, input.id)
      n = getNote(db, input.id)!
    }
    replaceLinksForNote(db, n.id, links)
    appendRevision(db, { revisionId: uuidv7(), noteId: n.id, body: n.body, type: n.type })
    return n
  })()

  return note
}
