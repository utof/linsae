/**
 * FTS5 full-text search wrapper over the `notes_fts` virtual table.
 *
 * Returns the top matches ranked by `bm25()` with `snippet()`-highlighted
 * excerpts. Soft-deleted notes are excluded from results.
 *
 * @see docs/specs/v0.1-rolling-feed-and-search.md §Data model (notes_fts)
 * @see docs/specs/v0.1-rolling-feed-and-search.md §User-facing surfaces (⌘K palette)
 * @see https://www.sqlite.org/fts5.html
 * @see src/main/db/migrations/0001_init.sql (notes_fts + triggers)
 */

import type Database from 'better-sqlite3'
import type { Note, SearchHit } from '../../../shared/types'

type DB = Database.Database

/**
 * Wrap raw user input as an FTS5 literal phrase by double-quoting it and
 * escaping embedded `"` as `""`.
 *
 * Why: FTS5 treats `"`, `(`, `)`, `:`, `*`, `^`, `-` etc. as query operators.
 * Raw input like `O'Hara` or `f(x)` produces `SQLITE_ERROR: fts5: syntax
 * error`. Quoting forces FTS5 to treat the whole string as a phrase.
 * Trade-off: this sacrifices boolean / NEAR query syntax — acceptable for
 * v0.1 where the ⌘K palette expects substring-like search.
 *
 * @see https://www.sqlite.org/fts5.html#full_text_query_syntax
 */
function ftsPhraseEscape(raw: string): string {
  return `"${raw.replace(/"/g, '""')}"`
}

/**
 * Runs an FTS5 query against `notes_fts` and returns hits ordered by `bm25()`.
 *
 * The join `notes_fts.rowid = notes.rowid` is required because FTS5 uses
 * SQLite's implicit INTEGER rowid, not `notes.id` (TEXT). See the spec's
 * §Data model note on `content_rowid='rowid'`.
 *
 * `bm25()` returns LOWER values for better matches, so `ORDER BY rank` (ASC)
 * surfaces the strongest matches first. `snippet(notes_fts, 0, ...)` uses
 * column index 0 = `body` (the only column in the virtual table).
 *
 * Why the try/catch: even with `ftsPhraseEscape`, pathological inputs (e.g.
 * unbalanced double-quotes upstream, future tokenizer changes) could still
 * throw. Returning `[]` keeps the renderer responsive rather than bubbling
 * a SQLite error to the user.
 *
 * @param db - Open better-sqlite3 Database.
 * @param opts.query - Raw user search string; will be phrase-escaped.
 * @param opts.limit - Maximum hits to return.
 * @returns Array of SearchHits ordered by bm25 ascending (best first).
 * @see docs/specs/v0.1-rolling-feed-and-search.md §User-facing surfaces
 */
export function searchNotes(db: DB, opts: { query: string; limit: number }): SearchHit[] {
  let rows: Array<Note & { snippet: string; rank: number }>
  try {
    rows = db
      .prepare(
        `SELECT n.id, n.slug, n.body, n.type, n.created_at, n.updated_at, n.deleted_at,
                snippet(notes_fts, 0, '<mark>', '</mark>', '…', 16) AS snippet,
                bm25(notes_fts) AS rank
         FROM notes_fts
         JOIN notes n ON n.rowid = notes_fts.rowid
         WHERE notes_fts MATCH ?
           AND n.deleted_at IS NULL
         ORDER BY rank
         LIMIT ?`,
      )
      .all(ftsPhraseEscape(opts.query), opts.limit) as Array<
      Note & { snippet: string; rank: number }
    >
  } catch {
    return []
  }

  return rows.map((r) => ({
    note: {
      id: r.id,
      slug: r.slug,
      body: r.body,
      type: r.type,
      created_at: r.created_at,
      updated_at: r.updated_at,
      deleted_at: r.deleted_at,
    },
    snippet: r.snippet,
    rank: r.rank,
  }))
}
