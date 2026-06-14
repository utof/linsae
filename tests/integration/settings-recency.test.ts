// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDb } from '../../src/main/db/client'
import { runMigrations } from '../../src/main/db/migrate'
import { listTitles, recentNotes, recordAccess } from '../../src/main/db/queries/recency'
import { getSetting, setSetting } from '../../src/main/db/queries/settings'
import { NotesDir } from '../../src/main/files/notes-dir'
import { saveNote } from '../../src/main/save-note'

let dir: string
let db: ReturnType<typeof openDb>
let nd: NotesDir
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'linsae-set-'))
  db = openDb(join(dir, 'test.db'))
  runMigrations(db)
  nd = new NotesDir(join(dir, 'notes'))
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('app_settings round-trip (real file db)', () => {
  it('defaults to null when absent, persists across reopen', () => {
    expect(getSetting(db, 'notes.recencyMode')).toBeNull()
    setSetting(db, 'notes.recencyMode', 'recent')
    db.close()
    db = openDb(join(dir, 'test.db'))
    expect(getSetting(db, 'notes.recencyMode')).toBe('recent')
  })
})

describe('note_access recency', () => {
  it('bump → recent ranks the just-accessed note first', () => {
    const a = saveNote(db, nd, { mode: 'create', body: '# A\n\nx', type: 'claim' })
    const b = saveNote(db, nd, { mode: 'create', body: '# B\n\nx', type: 'claim' })
    recordAccess(db, b.id, 1000)
    recordAccess(db, a.id, 2000) // a accessed more recently
    const recent = recentNotes(db, { mode: 'recent', limit: 5 }, 3000)
    expect(recent[0]!.id).toBe(a.id)
  })
  it('frecent weighs frequency × recency bucket', () => {
    const a = saveNote(db, nd, { mode: 'create', body: '# A\n\nx', type: 'claim' })
    const b = saveNote(db, nd, { mode: 'create', body: '# B\n\nx', type: 'claim' })
    const now = 10_000_000
    for (let i = 0; i < 5; i++) recordAccess(db, b.id, now - 2 * 3_600_000) // b: freq 5, ~2h old
    recordAccess(db, a.id, now - 30 * 60_000) // a: freq 1, 30m old
    const r = recentNotes(db, { mode: 'frecent', limit: 5 }, now)
    expect(r[0]!.id).toBe(b.id) // 5×2 = 10 beats 1×4 = 4
  })
  it('saveNote(update) bumps note_access (edit kind)', () => {
    const n = saveNote(db, nd, { mode: 'create', body: '# A\n\nx', type: 'claim' })
    expect(db.prepare('SELECT count(*) c FROM note_access').get()).toMatchObject({ c: 0 })
    saveNote(db, nd, { mode: 'update', id: n.id, body: '# A\n\ny', type: 'claim' })
    const row = db.prepare('SELECT frequency FROM note_access WHERE note_id = ?').get(n.id)
    expect(row).toMatchObject({ frequency: 1 })
  })
  it('listTitles returns ALL live notes (uncapped — past 500)', () => {
    // Seed directly into the DB (no file I/O) to stay within the 180s timeout.
    // listTitles only reads notes rows; file round-trip is not the concern here.
    db.transaction(() => {
      for (let i = 0; i < 520; i++) {
        db.prepare(
          `INSERT INTO notes (id, slug, body, type, created_at, updated_at)
           VALUES (?, ?, ?, 'claim', ?, ?)`,
        ).run(`id-${i}`, `note-${i}`, `# n${i}\n\nx`, i, i)
      }
    })()
    expect(listTitles(db).length).toBe(520)
  })
})
