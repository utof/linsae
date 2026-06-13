/**
 * Drawn-edge create/delete. Drawn edges are `links` rows with a non-reserved
 * `edge_type` ('link' or a free-text label) — so `replaceLinksForNote`
 * (deletes only edge_type='reference', links.ts) never wipes them. Slug-based
 * like wikilinks (spec §1). Reserved types are guarded here AND at the Zod
 * boundary (zod-schemas.ts) — defence in depth.
 * @see docs/specs/v0.4.1-canvas-edges.md §1 §2
 */
import type Database from 'better-sqlite3'

type DB = Database.Database

/**
 * edge_types managed by other subsystems; never valid drawn-edge labels.
 * 'reference' is wiped by replaceLinksForNote on every note save (links.ts:48);
 * 'comment-on' is managed by setCommentOnEdge (links.ts:153).
 * Using either as a drawn-edge type would silently destroy or impersonate data.
 * Why: defence in depth — also enforced at Zod boundary (zod-schemas.ts).
 * @see docs/specs/v0.4.1-canvas-edges.md §1
 */
export const RESERVED_EDGE_TYPES = ['reference', 'comment-on'] as const

/**
 * Resolve the slug of a live (non-deleted) note by id.
 * Returns null when the note doesn't exist or is soft-deleted.
 * Why: createDrawnEdge takes note IDs (the renderer has IDs) but stores slug
 * (the PK component, consistent with the slug-based link philosophy — spec §1 decision 4).
 */
function liveSlug(db: DB, noteId: string): string | null {
  const r = db.prepare(`SELECT slug FROM notes WHERE id=? AND deleted_at IS NULL`).get(noteId) as
    | { slug: string }
    | undefined
  return r?.slug ?? null
}

/**
 * Insert a drawn edge (`INSERT OR IGNORE` — idempotent on the composite PK).
 * Resolves `toNoteId` to its current slug so the stored row is slug-based
 * like wikilinks (spec §1 decision 4). Both liveness and self-edge checks run
 * inside the transaction to prevent TOCTOU races.
 *
 * @param db - Open better-sqlite3 Database.
 * @param i.fromNoteId - UUID of the source note (must be live).
 * @param i.toNoteId - UUID of the target note (must be live, must differ from from).
 * @param i.edgeType - User-supplied type label; must not be reserved or blank.
 * @throws If either note is soft-deleted/missing, if from===to, if edgeType is reserved/blank.
 * @see docs/specs/v0.4.1-canvas-edges.md §2
 */
export function createDrawnEdge(
  db: DB,
  i: { fromNoteId: string; toNoteId: string; edgeType: string },
): void {
  const type = i.edgeType.trim()
  if (type.length === 0) throw new Error('edgeType must be non-empty')
  if ((RESERVED_EDGE_TYPES as readonly string[]).includes(type))
    throw new Error(`edgeType '${type}' is reserved`)
  db.transaction(() => {
    if (i.fromNoteId === i.toNoteId) throw new Error('no self-edges')
    const fromSlug = liveSlug(db, i.fromNoteId)
    const toSlug = liveSlug(db, i.toNoteId)
    if (!fromSlug || !toSlug) throw new Error('both endpoints must be live notes')
    db.prepare(
      `INSERT OR IGNORE INTO links (from_note_id, to_slug, edge_type) VALUES (?, ?, ?)`,
    ).run(i.fromNoteId, toSlug, type)
  })()
}

/**
 * Delete the exact `links` PK row (`from_note_id`, `to_slug`, `edge_type`).
 * `toSlug` is taken from `canvas:edges` response (the `toSlug` field added in Task 1).
 * Refuses reserved edge_types — those are read-only on the canvas (spec §2 decision 6).
 *
 * @param db - Open better-sqlite3 Database.
 * @param i.fromNoteId - UUID of the source note.
 * @param i.toSlug - The exact `to_slug` PK value from the links row.
 * @param i.edgeType - Must NOT be a reserved type.
 * @throws If edgeType is 'reference' or 'comment-on'.
 * @see docs/specs/v0.4.1-canvas-edges.md §2
 */
export function deleteDrawnEdge(
  db: DB,
  i: { fromNoteId: string; toSlug: string; edgeType: string },
): void {
  if ((RESERVED_EDGE_TYPES as readonly string[]).includes(i.edgeType))
    throw new Error(`edgeType '${i.edgeType}' is read-only on the canvas`)
  db.prepare(`DELETE FROM links WHERE from_note_id=? AND to_slug=? AND edge_type=?`).run(
    i.fromNoteId,
    i.toSlug,
    i.edgeType,
  )
}
