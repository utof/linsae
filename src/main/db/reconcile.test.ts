// @vitest-environment node
/**
 * TDD tests for the reconciler.
 *
 * Uses a real on-disk notes directory via `mkdtempSync` + an in-memory SQLite
 * DB seeded via runMigrations — integration-style coverage of the file↔DB
 * round-trip per spec §Reconciler algorithm and the malformed-skip semantics.
 *
 * Why `@vitest-environment node`: native better-sqlite3 binding is incompatible
 * with jsdom (Node ABI vs browser-like sandbox). The directive overrides the
 * global jsdom default for this file, matching the pattern in sister tests
 * (notes.test.ts, links.test.ts, revisions.test.ts, search.test.ts).
 *
 * @see src/main/db/reconcile.ts
 * @see docs/plans/v0.1-rolling-feed-and-search.md §Task 19
 * @see docs/specs/v0.1-rolling-feed-and-search.md §Reconciler algorithm
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NotesDir } from '../files/notes-dir'
import { openDb } from './client'
import { runMigrations } from './migrate'
import { reconcile } from './reconcile'

type DB = Database.Database

let db: DB
let dir: string
let nd: NotesDir

beforeEach(() => {
  db = openDb(':memory:')
  runMigrations(db)
  dir = mkdtempSync(join(tmpdir(), 'linsae-reconcile-'))
  nd = new NotesDir(dir)
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('reconcile', () => {
  it('imports files-on-disk that are not in DB', () => {
    nd.writeNote(
      {
        id: 'aaaaaaaa-aaaa-7aaa-aaaa-aaaaaaaaaaaa',
        slug: 'a',
        type: 'claim',
        created_at: 1,
        updated_at: 1,
      },
      'hello',
    )
    const r = reconcile(db, nd)
    expect(r.inserted).toBe(1)
    expect(db.prepare('SELECT COUNT(*) AS c FROM notes').get()).toEqual({ c: 1 })
  })

  it('marks rows-in-DB-with-no-file as deleted_at', () => {
    db.prepare(
      `INSERT INTO notes (id, slug, body, type, created_at, updated_at)
       VALUES ('orphan', 'orphan', 'x', 'claim', 1, 1)`,
    ).run()
    const r = reconcile(db, nd)
    expect(r.deleted).toBe(1)
    const after = db.prepare('SELECT deleted_at FROM notes WHERE id = ?').get('orphan') as
      | { deleted_at: number | null }
      | undefined
    expect(after).toBeDefined()
    expect(after?.deleted_at).not.toBeNull()
  })

  it('skips files with malformed frontmatter and counts them', () => {
    writeFileSync(join(dir, 'corrupted-id.md'), '---\nslug: [unclosed\n---\nbody')
    const r = reconcile(db, nd)
    expect(r.skipped).toBe(1)
    expect(existsSync(join(dir, 'corrupted-id.md'))).toBe(true) // NOT deleted
  })

  it('updates a row when the file body hash changed', () => {
    nd.writeNote(
      {
        id: 'aaaaaaaa-aaaa-7aaa-aaaa-aaaaaaaaaaaa',
        slug: 'a',
        type: 'claim',
        created_at: 1,
        updated_at: 1,
      },
      'v1',
    )
    reconcile(db, nd) // initial import
    nd.writeNote(
      {
        id: 'aaaaaaaa-aaaa-7aaa-aaaa-aaaaaaaaaaaa',
        slug: 'a',
        type: 'claim',
        created_at: 1,
        updated_at: 2,
      },
      'v2',
    )
    const r = reconcile(db, nd)
    expect(r.updated).toBe(1)
    const after = db
      .prepare('SELECT body FROM notes WHERE id = ?')
      .get('aaaaaaaa-aaaa-7aaa-aaaa-aaaaaaaaaaaa') as { body: string } | undefined
    expect(after?.body).toBe('v2')
  })
})
