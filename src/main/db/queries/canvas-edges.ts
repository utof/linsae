/**
 * Read-only edge query for the canvas underlay (spec §11): every `links` row
 * whose from-note AND slug-resolved to-note are both PLACED (x NOT NULL) on
 * the given canvas/arrangement. Resolution inlines the live-slug join rather
 * than calling resolveWikilink per row — one query, no N+1.
 *
 * NEVER writes `links` — canvas edge creation is a future milestone with a
 * known trap (replaceLinksForNote wipes 'reference' rows; vision §Edge work).
 *
 * @see docs/specs/v0.4-canvas-mvp.md §11
 */
import type Database from 'better-sqlite3'
import type { CanvasEdge } from '../../../shared/canvas'

type DB = Database.Database

/**
 * Links whose BOTH endpoints are placed on this canvas/arrangement.
 * Why: one inlined join, no per-row resolveWikilink N+1; dangling slugs,
 * shelved endpoints, and soft-deleted notes simply don't match.
 * @see docs/specs/v0.4-canvas-mvp.md §11
 */
export function canvasEdges(db: DB, k: { canvasId: string; arrangementId: string }): CanvasEdge[] {
  return db
    .prepare(
      `SELECT lk.from_note_id AS fromNoteId, tn.id AS toNoteId, lk.to_slug AS toSlug, lk.edge_type AS edgeType
       FROM links lk
       JOIN notes tn ON tn.slug = lk.to_slug AND tn.deleted_at IS NULL
       JOIN node_layouts lf ON lf.note_id = lk.from_note_id
         AND lf.canvas_id = @canvasId AND lf.arrangement_id = @arrangementId AND lf.x IS NOT NULL
       JOIN node_layouts lt ON lt.note_id = tn.id
         AND lt.canvas_id = @canvasId AND lt.arrangement_id = @arrangementId AND lt.x IS NOT NULL
       JOIN notes fn ON fn.id = lk.from_note_id AND fn.deleted_at IS NULL`,
    )
    .all(k) as CanvasEdge[]
}
