// @vitest-environment node
/**
 * Verifies the 0002 migration is additive and produces the expected schema.
 * Real (in-memory) SQLite + the production migration runner.
 */
import { describe, expect, it } from 'vitest'
import { openDb } from '../../src/main/db/client'
import { runMigrations } from '../../src/main/db/migrate'

function colNames(db: ReturnType<typeof openDb>, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((r) => r.name)
}

describe('0002_video_threads migration', () => {
  it('creates video_sources and attachments tables with the expected columns', () => {
    const db = openDb(':memory:')
    runMigrations(db)

    expect(colNames(db, 'video_sources').sort()).toEqual(
      [
        'channel',
        'duration_sec',
        'fetched_at',
        'source_kind',
        'thumbnail_url',
        'title',
        'video_id',
      ].sort(),
    )
    expect(colNames(db, 'attachments').sort()).toEqual(
      [
        'base_path',
        'base_sha256',
        'created_at',
        'deleted_at',
        'device_pixel_ratio',
        'height_px',
        'id',
        'kind',
        'note_id',
        'overlay_path',
        'time_seconds',
        'video_id',
        'width_px',
      ].sort(),
    )
    db.close()
  })

  it('attachments.note_id FK uses ON DELETE SET NULL', () => {
    const db = openDb(':memory:')
    runMigrations(db)
    const fks = db.prepare(`PRAGMA foreign_key_list(attachments)`).all() as {
      table: string
      from: string
      on_delete: string
    }[]
    const noteFk = fks.find((f) => f.from === 'note_id')
    expect(noteFk?.table).toBe('notes')
    expect(noteFk?.on_delete).toBe('SET NULL')
    db.close()
  })

  it('is recorded in _migrations and is idempotent', () => {
    const db = openDb(':memory:')
    runMigrations(db)
    runMigrations(db)
    // The runner records the BASENAME (migrate.ts does `path.split('/').pop()`),
    // not the glob key — so assert '0002_video_threads.sql', not './migrations/…'.
    const names = (db.prepare('SELECT name FROM _migrations').all() as { name: string }[]).map(
      (r) => r.name,
    )
    expect(names).toContain('0002_video_threads.sql')
    db.close()
  })
})
