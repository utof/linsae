/**
 * Query wrappers for the `links` table — replace-on-write semantics for
 * outbound wikilinks and a backlinks lookup for the reverse direction.
 *
 * All functions accept an open better-sqlite3 Database and are side-effect
 * free beyond the DB call, mirroring the pattern in `./notes.ts`.
 *
 * @see docs/specs/v0.1-rolling-feed-and-search.md §Backlinks query
 * @see docs/specs/v0.1-rolling-feed-and-search.md §Wikilinks
 * @see docs/specs/v0.1-rolling-feed-and-search.md §Case-sensitivity
 * @see src/main/db/migrations/0001_init.sql
 */

import type Database from 'better-sqlite3'
import type { Attachment, Note, SourceLocator } from '../../../shared/types'
import type { Wikilink } from '../../text/wikilinks'

type DB = Database.Database

/**
 * Replaces the outbound `links` rows for `fromNoteId` with `links` atomically.
 *
 * The operation is delete-then-insert wrapped in a single transaction so
 * concurrent readers never observe a partially-rewritten edge set. `INSERT
 * OR IGNORE` handles the case where the same wikilink appears twice in the
 * body — the composite PK `(from_note_id, to_slug, edge_type)` collapses
 * the duplicates silently.
 *
 * Wikilinks arrive already slug-normalised (lowercased + trimmed) from
 * `extractWikilinks`, matching the case-sensitivity rule in the spec.
 *
 * Why: callers re-extract every wikilink on each save; "replace" is simpler
 * and safer than diffing the previous set, and the rowcount is small
 * (one note's outbound links).
 *
 * Replaces only the **`'reference'`** (wikilink-derived) outbound edges;
 * `'comment-on'` thread edges are managed separately via
 * {@link setCommentOnEdge} and are intentionally preserved across saves and
 * reconciles.
 *
 * @param db - Open better-sqlite3 Database.
 * @param fromNoteId - UUID of the source note whose outbound edges are being rewritten.
 * @param links - The full new set of outbound wikilinks; pass `[]` to clear.
 * @see docs/specs/v0.1-rolling-feed-and-search.md §Backlinks query
 */
export function replaceLinksForNote(db: DB, fromNoteId: string, links: Wikilink[]): void {
  const tx = db.transaction((id: string, ls: Wikilink[]) => {
    db.prepare(`DELETE FROM links WHERE from_note_id = ? AND edge_type = 'reference'`).run(id)
    if (ls.length === 0) return
    const insert = db.prepare(
      `INSERT OR IGNORE INTO links (from_note_id, to_slug, edge_type)
       VALUES (?, ?, 'reference')`,
    )
    for (const l of ls) insert.run(id, l.slug)
  })
  tx(fromNoteId, links)
}

/**
 * Returns the live (non-deleted) source notes whose body links to `toSlug`.
 *
 * Soft-deleted source notes are filtered out via `n.deleted_at IS NULL` so
 * the backlinks pane never displays a "(deleted) Note X linked here" entry —
 * see the spec's "Soft delete and backlinks" trade-off discussion.
 *
 * Why: ordered `created_at DESC` so the most recent reference surfaces
 * first, matching the spec's backlinks query verbatim.
 *
 * @param db - Open better-sqlite3 Database.
 * @param toSlug - Normalised target slug to look up in `links.to_slug`.
 * @returns Source notes (newest first) that currently link to `toSlug`.
 * @see docs/specs/v0.1-rolling-feed-and-search.md §Backlinks query
 * @see docs/specs/v0.1-rolling-feed-and-search.md §Soft delete and backlinks
 */
export function backlinks(db: DB, toSlug: string): Note[] {
  return db
    .prepare(
      `SELECT n.id, n.slug, n.body, n.type, n.created_at, n.updated_at, n.deleted_at
       FROM links l
       JOIN notes n ON n.id = l.from_note_id
       WHERE l.to_slug = ?
         AND n.deleted_at IS NULL
       ORDER BY n.created_at DESC`,
    )
    .all(toSlug) as Note[]
}

/**
 * Returns live (non-deleted) comment-notes whose `comment-on` edge targets `rootSlug`,
 * together with each note's latest live attachment (or `null` if none).
 *
 * The correlated attachment lookup uses `ORDER BY created_at DESC LIMIT 1` so a
 * future note with multiple screenshots still resolves correctly without a schema
 * change — v0.2.0 has at most one screenshot per comment-note.
 *
 * Why separate SELECT for attachment: a LEFT JOIN + LIMIT 1 inside a single query
 * does not work portably with SQLite correlated subqueries at the column position;
 * two statements per row keeps the SQL simple and the result predictable.
 *
 * Why `source_kind`/`source_locator`: thread items need the timestamp `t` from
 * `source_locator.t` to place themselves on the rail — omitting these columns would
 * force a second `getNote` call for every row.
 *
 * @param db - Open better-sqlite3 Database.
 * @param rootSlug - Slug of the root note that is the thread target (any note type, not just videos).
 * @returns Comment-notes (oldest first) with their latest live screenshot attachment.
 * @see https://github.com/utof/linsae/issues/36
 * @issue utof/linsae#36
 * @see adrs/0010-comment-on-edge.md
 */
export function commentsForNote(
  db: DB,
  rootSlug: string,
): Array<{ note: Note; attachment: Attachment | null }> {
  const rows = db
    .prepare(
      `SELECT n.id, n.slug, n.body, n.type, n.created_at, n.updated_at, n.deleted_at,
              n.source_kind, n.source_locator
       FROM notes n
       JOIN links l ON l.from_note_id = n.id
       WHERE l.to_slug = ? AND l.edge_type = 'comment-on' AND n.deleted_at IS NULL
       ORDER BY n.created_at`,
    )
    .all(rootSlug) as Array<Omit<Note, 'source_locator'> & { source_locator: string | null }>

  const attachStmt = db.prepare(
    `SELECT id, note_id, kind, base_sha256, base_path, overlay_path, video_id,
            time_seconds, width_px, height_px, device_pixel_ratio, created_at, deleted_at
     FROM attachments WHERE note_id = ? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1`,
  )

  return rows.map((row) => {
    const note: Note = {
      ...row,
      source_locator: row.source_locator ? (JSON.parse(row.source_locator) as SourceLocator) : null,
    }
    const attachment = (attachStmt.get(note.id) as Attachment | undefined) ?? null
    return { note, attachment }
  })
}

/**
 * Creates the `comment-on` edge linking a comment-note to its video-note
 * (`edge_type='comment-on'`, spec §links / ADR 0010). Idempotent via the
 * composite PK `(from_note_id, to_slug, edge_type)`. Unlike reference edges,
 * comment-on edges are NOT derived from the body and survive
 * {@link replaceLinksForNote} (which is scoped to `'reference'`).
 *
 * @param db - Open better-sqlite3 Database.
 * @param fromNoteId - The comment-note's id.
 * @param toVideoSlug - The video-note's slug (the thread it belongs to).
 */
export function setCommentOnEdge(db: DB, fromNoteId: string, toVideoSlug: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO links (from_note_id, to_slug, edge_type) VALUES (?, ?, 'comment-on')`,
  ).run(fromNoteId, toVideoSlug)
}
