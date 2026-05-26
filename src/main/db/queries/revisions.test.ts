// @vitest-environment node
/**
 * TDD tests for note_revisions query wrappers.
 *
 * Uses an in-memory SQLite DB seeded via runMigrations — no disk I/O.
 *
 * Why: native better-sqlite3 binding is incompatible with jsdom (Node ABI vs
 * browser-like sandbox). The `@vitest-environment node` directive overrides
 * the global jsdom default for this file.
 *
 * @see src/main/db/queries/revisions.ts
 * @see docs/plans/v0.1-rolling-feed-and-search.md §Task 17
 * @see docs/specs/v0.1-rolling-feed-and-search.md §Data model (note_revisions)
 */

import type Database from 'better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'
import { openDb } from '../client'
import { runMigrations } from '../migrate'
import { createNote } from './notes'
import { appendRevision, listRevisions } from './revisions'

type DB = Database.Database

let db: DB
beforeEach(() => {
  db = openDb(':memory:')
  runMigrations(db)
  createNote(db, { id: 'n1', slug: 'a', body: 'v1', type: 'claim' })
})

describe('revisions', () => {
  it('appendRevision adds a row with supersedes pointing at prior most-recent', () => {
    const r1 = appendRevision(db, { revisionId: 'r1', noteId: 'n1', body: 'v1', type: 'claim' })
    expect(r1.supersedes).toBe(null)
    const r2 = appendRevision(db, { revisionId: 'r2', noteId: 'n1', body: 'v2', type: 'claim' })
    expect(r2.supersedes).toBe('r1')
  })

  it('listRevisions returns newest first', async () => {
    appendRevision(db, { revisionId: 'r1', noteId: 'n1', body: 'v1', type: 'claim' })
    // 2ms gap so r2.saved_at > r1.saved_at deterministically (matches notes.test.ts pattern).
    await new Promise((resolve) => setTimeout(resolve, 2))
    appendRevision(db, { revisionId: 'r2', noteId: 'n1', body: 'v2', type: 'claim' })
    expect(listRevisions(db, 'n1').map((r) => r.id)).toEqual(['r2', 'r1'])
  })
})
