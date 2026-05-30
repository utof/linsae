/**
 * Query wrappers for the `attachments` table.
 *
 * Same pattern as ./notes.ts. id (uuidv7) and created_at (Date.now()) are
 * generated inside insertAttachment so callers (the capture IPC) stay thin.
 * All read queries carry `WHERE deleted_at IS NULL` (and the orphan query also
 * `note_id IS NULL`) so the partial indexes in 0002 are used (spec §Data model).
 *
 * @see src/main/db/migrations/0002_video_threads.sql
 * @see docs/specs/v0.2-youtube-annotation.md §Data model
 */
import type Database from 'better-sqlite3'
import { uuidv7 } from 'uuidv7'
import type { Attachment, AttachmentKind } from '../../../shared/types'

type DB = Database.Database

interface InsertAttachmentInput {
  note_id?: string | null
  kind: AttachmentKind
  base_sha256: string
  base_path: string
  overlay_path?: string | null
  video_id?: string | null
  time_seconds?: number | null
  width_px: number
  height_px: number
  device_pixel_ratio: number
}

const SELECT_COLS = `id, note_id, kind, base_sha256, base_path, overlay_path,
  video_id, time_seconds, width_px, height_px, device_pixel_ratio, created_at, deleted_at`

/** Inserts an attachment (born an orphan unless note_id given) and returns it. */
export function insertAttachment(db: DB, input: InsertAttachmentInput): Attachment {
  const id = uuidv7()
  const created_at = Date.now()
  db.prepare(
    `INSERT INTO attachments
       (id, note_id, kind, base_sha256, base_path, overlay_path, video_id,
        time_seconds, width_px, height_px, device_pixel_ratio, created_at, deleted_at)
     VALUES
       (@id, @note_id, @kind, @base_sha256, @base_path, @overlay_path, @video_id,
        @time_seconds, @width_px, @height_px, @device_pixel_ratio, @created_at, NULL)`,
  ).run({
    id,
    note_id: input.note_id ?? null,
    kind: input.kind,
    base_sha256: input.base_sha256,
    base_path: input.base_path,
    overlay_path: input.overlay_path ?? null,
    video_id: input.video_id ?? null,
    time_seconds: input.time_seconds ?? null,
    width_px: input.width_px,
    height_px: input.height_px,
    device_pixel_ratio: input.device_pixel_ratio,
    created_at,
  })
  return getAttachment(db, id)!
}

/** Retrieves one attachment by id, including soft-deleted (internal helper). */
function getAttachment(db: DB, id: string): Attachment | null {
  return (
    (db.prepare(`SELECT ${SELECT_COLS} FROM attachments WHERE id = ?`).get(id) as
      | Attachment
      | undefined) ?? null
  )
}

/** Live attachments sharing a content hash (file-layer dedup is by sha256). */
export function getAttachmentsByHash(db: DB, sha256: string): Attachment[] {
  return db
    .prepare(`SELECT ${SELECT_COLS} FROM attachments WHERE base_sha256 = ? AND deleted_at IS NULL`)
    .all(sha256) as Attachment[]
}

/** Points an orphan attachment at a note. */
export function attachToNote(db: DB, args: { id: string; noteId: string }): void {
  db.prepare(`UPDATE attachments SET note_id = ? WHERE id = ?`).run(args.noteId, args.id)
}

/** Unattached, non-deleted attachments, oldest first (orphan tray). */
export function listOrphanAttachments(db: DB): Attachment[] {
  return db
    .prepare(
      `SELECT ${SELECT_COLS} FROM attachments
       WHERE note_id IS NULL AND deleted_at IS NULL ORDER BY created_at`,
    )
    .all() as Attachment[]
}

/** Live attachments belonging to a note. */
export function listAttachmentsForNote(db: DB, noteId: string): Attachment[] {
  return db
    .prepare(`SELECT ${SELECT_COLS} FROM attachments WHERE note_id = ? AND deleted_at IS NULL`)
    .all(noteId) as Attachment[]
}

/** Soft-deletes an attachment (PNG bytes on disk are not touched). */
export function softDeleteAttachment(db: DB, id: string): void {
  db.prepare(`UPDATE attachments SET deleted_at = ? WHERE id = ?`).run(Date.now(), id)
}
