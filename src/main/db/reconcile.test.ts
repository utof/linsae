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

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NotesDir } from '../files/notes-dir'
import { openDb } from './client'
import { runMigrations } from './migrate'
import { setCommentOnEdge } from './queries/links'
import { getNote } from './queries/notes'
import { listRevisions } from './queries/revisions'
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

  it('skips files whose slug collides with another live file (UNIQUE constraint) without aborting the scan', () => {
    // Two valid frontmatters that derive the same slug — the partial unique
    // index `idx_notes_slug_live` rejects the second INSERT. Without the
    // savepoint wrapper added to fix issue #23, this throw kills the entire
    // outer transaction at startup and the renderer fails to launch.
    nd.writeNote(
      {
        id: 'aaaaaaaa-aaaa-7aaa-aaaa-aaaaaaaaaaa1',
        slug: 'dup',
        type: 'claim',
        created_at: 1,
        updated_at: 1,
      },
      'abc',
    )
    nd.writeNote(
      {
        id: 'aaaaaaaa-aaaa-7aaa-aaaa-aaaaaaaaaaa2',
        slug: 'dup',
        type: 'claim',
        created_at: 2,
        updated_at: 2,
      },
      'abc',
    )
    const r = reconcile(db, nd)
    expect(r.inserted).toBe(1)
    expect(r.skipped).toBe(1)
    // Both files remain on disk; neither is destroyed.
    expect(existsSync(join(dir, 'aaaaaaaa-aaaa-7aaa-aaaa-aaaaaaaaaaa1.md'))).toBe(true)
    expect(existsSync(join(dir, 'aaaaaaaa-aaaa-7aaa-aaaa-aaaaaaaaaaa2.md'))).toBe(true)
    // Exactly one row landed in the DB (whichever fs.readdir surfaced first).
    expect(db.prepare('SELECT COUNT(*) AS c FROM notes').get()).toEqual({ c: 1 })
  })

  it('writes dup-slug skips to reconcile.log when logsDir is provided', () => {
    const logsDir = join(dir, 'logs')
    nd.writeNote(
      {
        id: 'aaaaaaaa-aaaa-7aaa-aaaa-aaaaaaaaaaa3',
        slug: 'dup',
        type: 'claim',
        created_at: 1,
        updated_at: 1,
      },
      'abc',
    )
    nd.writeNote(
      {
        id: 'aaaaaaaa-aaaa-7aaa-aaaa-aaaaaaaaaaa4',
        slug: 'dup',
        type: 'claim',
        created_at: 2,
        updated_at: 2,
      },
      'abc',
    )
    reconcile(db, nd, logsDir)
    const log = readFileSync(join(logsDir, 'reconcile.log'), 'utf8')
    expect(log).toMatch(/UNIQUE constraint failed/)
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
    // Spec §Reconciler algorithm: external-edit UPDATE appends a note_revisions row.
    const revs = listRevisions(db, 'aaaaaaaa-aaaa-7aaa-aaaa-aaaaaaaaaaaa')
    expect(revs).toHaveLength(1)
    expect(revs[0]?.body).toBe('v2')
  })

  it('reconcile writes source_kind/source_locator from frontmatter on insert', () => {
    // write a note file with source frontmatter directly to disk
    nd.writeNote(
      {
        id: 'vid-note',
        slug: 'vid-note',
        type: 'source',
        created_at: 1,
        updated_at: 1,
        source_kind: 'youtube',
        source_locator: { media: 'youtube', video_id: 'abc123' },
      },
      '# a video',
    )
    reconcile(db, nd)
    const n = getNote(db, 'vid-note')
    expect(n?.source_kind).toBe('youtube')
    expect(n?.source_locator).toEqual({ media: 'youtube', video_id: 'abc123' })
  })

  it('reconcile UPDATE (external body edit) preserves a comment-on edge', () => {
    // seed: note in DB with a comment-on edge, file on disk with same id
    nd.writeNote({ id: 'c9', slug: 'c9', type: 'claim', created_at: 1, updated_at: 1 }, 'orig body')
    reconcile(db, nd) // inserts c9
    setCommentOnEdge(db, 'c9', 'some-video')
    // external edit changes the body → reconcile UPDATE path
    nd.writeNote(
      { id: 'c9', slug: 'c9', type: 'claim', created_at: 1, updated_at: 2 },
      'edited body',
    )
    reconcile(db, nd)
    const edges = db.prepare(`SELECT edge_type FROM links WHERE from_note_id='c9'`).all() as {
      edge_type: string
    }[]
    expect(edges.some((e) => e.edge_type === 'comment-on')).toBe(true)
  })

  it('reconcile UPDATE reflects a changed source_locator from frontmatter', () => {
    // insert a video-note, then change BOTH its source_locator and body on disk
    // (the body change is what trips reconcile's hashBody change-oracle into the
    // UPDATE branch — this exercises the UPDATE source_kind/source_locator binds).
    nd.writeNote(
      {
        id: 'vid2',
        slug: 'vid2',
        type: 'source',
        created_at: 1,
        updated_at: 1,
        source_kind: 'youtube',
        source_locator: { media: 'youtube', video_id: 'abc123' },
      },
      'orig body',
    )
    reconcile(db, nd) // INSERT
    nd.writeNote(
      {
        id: 'vid2',
        slug: 'vid2',
        type: 'source',
        created_at: 1,
        updated_at: 2,
        source_kind: 'youtube',
        source_locator: { media: 'youtube', video_id: 'xyz789', t: 42 },
      },
      'edited body',
    )
    reconcile(db, nd) // UPDATE
    const n = getNote(db, 'vid2')
    expect(n?.source_locator).toEqual({ media: 'youtube', video_id: 'xyz789', t: 42 })
  })
})
