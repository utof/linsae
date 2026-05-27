// @vitest-environment node
/**
 * Integration test: external edit between sessions.
 *
 * Simulates the user editing a note in vim/Obsidian while the app is closed,
 * then verifies that the next-startup reconciler picks up the change (per spec
 * §External edits, line 189: "If the user edits a note in vim/Obsidian/any
 * other editor between app sessions, the reconciler picks up the change on
 * next launch.").
 *
 * Uses real disk (mkdtempSync) AND a real SQLite file (NOT `:memory:`) because
 * the test models a session boundary — close DB, mutate file, reopen DB.
 *
 * Why `@vitest-environment node`: native better-sqlite3 binding requires the
 * Node ABI; jsdom would break it. Matches sister tests.
 *
 * @see src/main/db/reconcile.ts
 * @see docs/plans/v0.1-rolling-feed-and-search.md §Task 32
 * @see docs/specs/v0.1-rolling-feed-and-search.md §External edits
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDb } from '../../src/main/db/client'
import { runMigrations } from '../../src/main/db/migrate'
import { reconcile } from '../../src/main/db/reconcile'
import { NotesDir } from '../../src/main/files/notes-dir'
import { saveNote } from '../../src/main/save-note'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'linsae-ext-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('external edit while app is closed', () => {
  it('reconciler picks up an externally-edited file body', () => {
    const notesDir = join(dir, 'notes')
    const dbPath = join(dir, 'db.sqlite')
    let nd = new NotesDir(notesDir)
    let db = openDb(dbPath)
    runMigrations(db)
    const n = saveNote(db, nd, { mode: 'create', body: 'original', type: 'claim' })
    db.close()

    // Simulate external edit: rewrite the file with a new body while DB is closed.
    nd = new NotesDir(notesDir)
    nd.writeNote(
      {
        id: n.id,
        slug: n.slug,
        type: 'claim',
        created_at: n.created_at,
        updated_at: n.created_at + 1000,
      },
      'externally edited',
    )

    db = openDb(dbPath)
    runMigrations(db)
    const report = reconcile(db, nd)
    expect(report.updated).toBe(1)
    const after = db.prepare('SELECT body FROM notes WHERE id = ?').get(n.id) as
      | { body: string }
      | undefined
    expect(after?.body).toBe('externally edited')
    db.close()
  })
})
