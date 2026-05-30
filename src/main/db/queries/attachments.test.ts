// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import { openDb } from '../client'
import { runMigrations } from '../migrate'
import {
  attachToNote,
  getAttachmentsByHash,
  insertAttachment,
  listAttachmentsByTitleLike,
  listAttachmentsByVideo,
  listAttachmentsForNote,
  listOrphanAttachments,
  softDeleteAttachment,
} from './attachments'

let db: ReturnType<typeof openDb>
beforeEach(() => {
  db = openDb(':memory:')
  runMigrations(db)
})

const base = {
  kind: 'screenshot' as const,
  base_sha256: 'abc123',
  base_path: '/tmp/a/abc123.png',
  video_id: 'dQw4w9WgXcQ',
  time_seconds: 83.5,
  width_px: 2560,
  height_px: 1440,
  device_pixel_ratio: 2,
}

// Insert a real note so FK constraints (foreign_keys = ON) are satisfiable.
function makeNote(id: string): void {
  db.prepare(
    `INSERT INTO notes (id, slug, body, type, created_at, updated_at)
     VALUES (?, ?, 'x', 'claim', 0, 0)`,
  ).run(id, id)
}

describe('attachments queries', () => {
  it('insert returns a hydrated row born as an orphan (note_id null)', () => {
    const a = insertAttachment(db, base)
    expect(a.note_id).toBeNull()
    expect(a.id).toMatch(/.+/)
    expect(a).toMatchObject({ base_sha256: 'abc123', width_px: 2560, device_pixel_ratio: 2 })
    expect(typeof a.created_at).toBe('number')
  })

  it('listOrphanAttachments returns unattached, non-deleted rows', () => {
    insertAttachment(db, base)
    insertAttachment(db, { ...base, base_sha256: 'def456', base_path: '/tmp/a/def456.png' })
    expect(listOrphanAttachments(db)).toHaveLength(2)
  })

  it('attachToNote links the orphan and removes it from the orphan list', () => {
    makeNote('note-1')
    const a = insertAttachment(db, base)
    attachToNote(db, { id: a.id, noteId: 'note-1' })
    expect(listOrphanAttachments(db)).toHaveLength(0)
    expect(listAttachmentsForNote(db, 'note-1')).toHaveLength(1)
  })

  it('getAttachmentsByHash finds live rows by content hash', () => {
    insertAttachment(db, base)
    insertAttachment(db, base) // identical bytes → distinct rows, same hash (spec B4)
    expect(getAttachmentsByHash(db, 'abc123')).toHaveLength(2)
  })

  it('softDeleteAttachment hides the row from all live queries', () => {
    const a = insertAttachment(db, base)
    softDeleteAttachment(db, a.id)
    expect(listOrphanAttachments(db)).toHaveLength(0)
    expect(getAttachmentsByHash(db, 'abc123')).toHaveLength(0)
  })

  it('deleting the parent note orphans the attachment (ON DELETE SET NULL)', () => {
    makeNote('note-1')
    const a = insertAttachment(db, base)
    attachToNote(db, { id: a.id, noteId: 'note-1' })
    db.prepare('DELETE FROM notes WHERE id = ?').run('note-1')
    const orphans = listOrphanAttachments(db)
    expect(orphans.map((o) => o.id)).toContain(a.id)
  })

  it('listAttachmentsByVideo returns live rows for a video id', () => {
    insertAttachment(db, base)
    insertAttachment(db, { ...base, base_sha256: 'd2', base_path: '/tmp/a/d2.png' })
    insertAttachment(db, {
      ...base,
      video_id: 'other',
      base_sha256: 'd3',
      base_path: '/tmp/a/d3.png',
    })
    expect(listAttachmentsByVideo(db, 'dQw4w9WgXcQ')).toHaveLength(2)
  })

  it('listAttachmentsByTitleLike matches via the video_sources title (case-insensitive substring)', () => {
    db.prepare(
      `INSERT INTO video_sources (video_id, source_kind, title, fetched_at) VALUES (?, 'youtube', ?, 0)`,
    ).run('dQw4w9WgXcQ', 'Serre Spectral Sequences')
    insertAttachment(db, base)
    expect(listAttachmentsByTitleLike(db, 'spectral')).toHaveLength(1)
    expect(listAttachmentsByTitleLike(db, 'nomatch')).toHaveLength(0)
  })
})
