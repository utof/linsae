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
import { deriveTitle } from '../../../shared/note-title'
import type { Note, SearchHit } from '../../../shared/types'

type DB = Database.Database

/**
 * Wrap a single raw token as an FTS5 literal phrase by double-quoting it and
 * escaping embedded `"` as `""`.
 *
 * Why: FTS5 treats `"`, `(`, `)`, `:`, `*`, `^`, `-` etc. as query operators.
 * Raw input like `O'Hara` or `f(x)` produces `SQLITE_ERROR: fts5: syntax
 * error`. Quoting forces FTS5 to treat the token as a phrase.
 * Now used per-token by {@link buildMatch}.
 *
 * @see https://www.sqlite.org/fts5.html#full_text_query_syntax
 */
function ftsPhraseEscape(raw: string): string {
  return `"${raw.replace(/"/g, '""')}"`
}

/**
 * Build the FTS5 MATCH string from raw user input: split on whitespace,
 * phrase-escape each token, and append a prefix `*` to the LAST token only
 * (search-as-you-type — spec §6 decision). The `*` goes OUTSIDE the closing
 * quote: `"annot"*` is a prefix token, but `"annot*"` sends `*` to the
 * tokenizer (literal) and will NOT prefix-match. Tokens that escape to an
 * empty phrase (`""`, punctuation-only) are dropped so we never emit a bare
 * `*` or an unbalanced query. Returns '' when nothing usable remains.
 * @see https://www.sqlite.org/fts5.html#full_text_query_syntax (prefix queries)
 */
export function buildMatch(raw: string): string {
  const tokens = raw
    .trim()
    .split(/\s+/)
    .map((t) => t.replace(/[^\p{L}\p{N}]/gu, '')) // strip punctuation that breaks phrases
    .filter((t) => t.length > 0)
  if (tokens.length === 0) return ''
  return tokens
    .map((t, i) => (i === tokens.length - 1 ? `${ftsPhraseEscape(t)}*` : ftsPhraseEscape(t)))
    .join(' ')
}

/**
 * Runs an FTS5 query against `notes_fts` and returns hits ordered by `bm25()`.
 *
 * The join `notes_fts.rowid = notes.rowid` is required because FTS5 uses
 * SQLite's implicit INTEGER rowid, not `notes.id` (TEXT). See the spec's
 * §Data model note on `content_rowid='rowid'`.
 *
 * `bm25(notes_fts, 10.0, 1.0)` weights the `slug` column (index 0) 10× the
 * `body` column (index 1), so title-word hits float above body-only hits
 * (spec §1.1). `bm25()` returns LOWER values for better matches, so
 * `ORDER BY rank` (ASC) surfaces the strongest matches first.
 * `snippet(notes_fts, 1, ...)` uses column index 1 = `body` (index 0 is now
 * `slug`, added in migration 0004).
 *
 * The MATCH string comes from {@link buildMatch} (per-token phrase escape +
 * last-token prefix `*`), so empty / punctuation-only input short-circuits to
 * `[]` before touching SQLite.
 *
 * Why the try/catch: even with {@link buildMatch}, pathological inputs (e.g.
 * future tokenizer changes) could still throw. Returning `[]` keeps the
 * renderer responsive rather than bubbling a SQLite error to the user.
 *
 * @param db - Open better-sqlite3 Database.
 * @param opts.query - Raw user search string; passed to {@link buildMatch}.
 * @param opts.limit - Maximum hits to return.
 * @returns Array of SearchHits ordered by bm25 ascending (best first).
 * @see docs/specs/v0.5-command-search.md §1.1 (slug-weighted bm25)
 * @see docs/specs/v0.1-rolling-feed-and-search.md §User-facing surfaces
 */
export function searchNotes(db: DB, opts: { query: string; limit: number }): SearchHit[] {
  const match = buildMatch(opts.query)
  if (match === '') return []
  let rows: Array<Note & { snippet: string; rank: number }>
  try {
    rows = db
      .prepare(
        `SELECT n.id, n.slug, n.body, n.type, n.created_at, n.updated_at, n.deleted_at,
                snippet(notes_fts, 1, '<mark>', '</mark>', '…', 16) AS snippet,
                bm25(notes_fts, 10.0, 1.0) AS rank
         FROM notes_fts
         JOIN notes n ON n.rowid = notes_fts.rowid
         WHERE notes_fts MATCH ?
           AND n.deleted_at IS NULL
         ORDER BY rank
         LIMIT ?`,
      )
      .all(match, opts.limit) as Array<Note & { snippet: string; rank: number }>
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
    title: deriveTitle(r.body) || r.slug,
    snippet: r.snippet,
    rank: r.rank,
  }))
}
