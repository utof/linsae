// @vitest-environment node
/**
 * Integration test: file ↔ DB round trip via the production save + reconcile path.
 *
 * Uses real disk (mkdtempSync) AND a real SQLite file (NOT `:memory:`) because
 * the "restart" and "orphan recovery" scenarios require cross-session DB
 * persistence — opening, closing, then reopening `db.sqlite` at the same path.
 *
 * Why `@vitest-environment node`: native better-sqlite3 binding is incompatible
 * with jsdom (Node ABI vs browser-like sandbox). Matches the directive used in
 * sister tests (notes.test.ts, reconcile.test.ts).
 *
 * @see src/main/save-note.ts
 * @see src/main/db/reconcile.ts
 * @see docs/plans/v0.1-rolling-feed-and-search.md §Task 31
 * @see docs/specs/v0.1-rolling-feed-and-search.md §Storage architecture
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDb } from '../../src/main/db/client'
import { runMigrations } from '../../src/main/db/migrate'
import { reconcile } from '../../src/main/db/reconcile'
import { NotesDir } from '../../src/main/files/notes-dir'
import { saveNote } from '../../src/main/save-note'

let dir: string
let dbPath: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'linsae-int-'))
  dbPath = join(dir, 'db.sqlite')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('file↔DB round trip', () => {
  it('create note → file on disk + DB row + revision + reconcile is no-op', () => {
    const notesDir = join(dir, 'notes')
    const nd = new NotesDir(notesDir)
    const db = openDb(dbPath)
    runMigrations(db)

    const n = saveNote(db, nd, { mode: 'create', body: '# Foo\n\nbody', type: 'claim' })
    expect(existsSync(join(notesDir, `${n.id}.md`))).toBe(true)
    const raw = readFileSync(join(notesDir, `${n.id}.md`), 'utf8')
    expect(raw).toContain('slug: foo')
    expect(
      db.prepare('SELECT COUNT(*) AS c FROM note_revisions WHERE note_id = ?').get(n.id),
    ).toEqual({ c: 1 })

    const report = reconcile(db, nd)
    expect(report.inserted + report.updated + report.deleted).toBe(0)

    db.close()
  })

  it('restart: re-open DB, run reconciler → state preserved', () => {
    const notesDir = join(dir, 'notes')
    let nd = new NotesDir(notesDir)
    let db = openDb(dbPath)
    runMigrations(db)
    saveNote(db, nd, { mode: 'create', body: 'hello', type: 'claim' })
    db.close()

    nd = new NotesDir(notesDir)
    db = openDb(dbPath)
    runMigrations(db)
    reconcile(db, nd)
    expect(db.prepare('SELECT COUNT(*) AS c FROM notes').get()).toEqual({ c: 1 })
    db.close()
  })

  it('orphan recovery: delete DB, restart → reconciler rebuilds from disk', () => {
    const notesDir = join(dir, 'notes')
    let nd = new NotesDir(notesDir)
    let db = openDb(dbPath)
    runMigrations(db)
    const n = saveNote(db, nd, { mode: 'create', body: '# X', type: 'claim' })
    db.close()

    rmSync(dbPath)
    nd = new NotesDir(notesDir)
    db = openDb(dbPath)
    runMigrations(db)
    const report = reconcile(db, nd)
    expect(report.inserted).toBe(1)
    expect(db.prepare('SELECT id, slug FROM notes').get()).toEqual({ id: n.id, slug: 'x' })
    db.close()
  })
})
