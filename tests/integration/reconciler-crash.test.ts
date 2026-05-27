// @vitest-environment node
/**
 * Integration test: reconciler crash recovery (malformed-file skip without data loss).
 *
 * Verifies the spec contract at §Reconciler algorithm line 179: malformed
 * frontmatter is logged + counted + the file is left on disk; never deleted.
 * Good files on disk in the same scan are imported normally.
 *
 * Uses real disk (mkdtempSync) AND a real SQLite file (NOT `:memory:`) for
 * parity with the other integration tests in this batch; both `openDb` and the
 * reconciler are exercised against an actual `.sqlite` file rather than the
 * in-memory connection used in unit-style reconcile.test.ts.
 *
 * Why `@vitest-environment node`: native better-sqlite3 binding requires the
 * Node ABI; jsdom would break it.
 *
 * @see src/main/db/reconcile.ts
 * @see docs/plans/v0.1-rolling-feed-and-search.md §Task 33
 * @see docs/specs/v0.1-rolling-feed-and-search.md §Reconciler algorithm
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDb } from '../../src/main/db/client'
import { runMigrations } from '../../src/main/db/migrate'
import { reconcile } from '../../src/main/db/reconcile'
import { NotesDir } from '../../src/main/files/notes-dir'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'linsae-crash-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('reconciler handles malformed frontmatter without data loss', () => {
  it('skips bad files, imports good files, leaves bad files on disk', () => {
    const notesDir = join(dir, 'notes')
    const dbPath = join(dir, 'db.sqlite')
    const nd = new NotesDir(notesDir)
    const db = openDb(dbPath)
    runMigrations(db)

    nd.writeNote(
      {
        id: 'aaaaaaaa-aaaa-7aaa-aaaa-aaaaaaaaaaaa',
        slug: 'good',
        type: 'claim',
        created_at: 1,
        updated_at: 1,
      },
      'good body',
    )
    writeFileSync(join(notesDir, 'corrupted-id.md'), '---\nslug: [unclosed\n---\nbody')

    const r = reconcile(db, nd)
    expect(r.inserted).toBe(1)
    expect(r.skipped).toBe(1)
    expect(existsSync(join(notesDir, 'corrupted-id.md'))).toBe(true)
    db.close()
  })
})
