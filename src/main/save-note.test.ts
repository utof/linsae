// @vitest-environment node
/**
 * TDD tests for the saveNote orchestrator.
 *
 * Uses a real on-disk SQLite (via `:memory:` for speed) plus a real `mkdtempSync`
 * notes directory so that the file-first / DB-second contract is exercised
 * end-to-end (atomic tmp+fsync+rename in `nd.writeNote`, then the DB
 * transaction). The whole flow is the integration boundary.
 *
 * Why `@vitest-environment node`: native better-sqlite3 binding is incompatible
 * with jsdom (Node ABI vs browser-like sandbox). Same directive used by sister
 * tests in `src/main/db/queries/*.test.ts`.
 *
 * @see src/main/save-note.ts
 * @see docs/plans/v0.1-rolling-feed-and-search.md §Task 18
 * @see docs/specs/v0.1-rolling-feed-and-search.md §Storage architecture
 * @see docs/specs/v0.1-rolling-feed-and-search.md §Write atomicity (per save)
 * @see docs/specs/v0.1-rolling-feed-and-search.md §Soft delete and backlinks
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDb } from './db/client'
import { runMigrations } from './db/migrate'
import { listRevisions } from './db/queries/revisions'
import { NotesDir } from './files/notes-dir'
import { saveNote } from './save-note'

type DB = Database.Database

let db: DB
let dir: string
let nd: NotesDir
beforeEach(() => {
  db = openDb(':memory:')
  runMigrations(db)
  dir = mkdtempSync(join(tmpdir(), 'linsae-save-'))
  nd = new NotesDir(dir)
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('saveNote', () => {
  it('creates: writes file, inserts note + revision, no links if body has none', () => {
    const n = saveNote(db, nd, { mode: 'create', body: '# Foo\n\nbody no links', type: 'claim' })
    expect(n.slug).toBe('foo')
    const raw = readFileSync(join(dir, `${n.id}.md`), 'utf8')
    expect(raw).toContain('slug: foo')
    expect(listRevisions(db, n.id).length).toBe(1)
  })

  it('creates: parses [[wikilink]] and inserts a links row', () => {
    const n = saveNote(db, nd, { mode: 'create', body: 'see [[target]]', type: 'claim' })
    const r = db.prepare('SELECT * FROM links WHERE from_note_id = ?').all(n.id)
    expect(r.length).toBe(1)
  })

  it('updates: rewrites file, appends revision, replaces links', () => {
    const n = saveNote(db, nd, { mode: 'create', body: 'a [[x]]', type: 'claim' })
    saveNote(db, nd, { mode: 'update', id: n.id, body: 'b [[y]]', type: 'claim' })
    const links = db.prepare('SELECT to_slug FROM links WHERE from_note_id = ?').all(n.id) as {
      to_slug: string
    }[]
    expect(links.map((l) => l.to_slug)).toEqual(['y'])
    expect(listRevisions(db, n.id).length).toBe(2)
  })

  it('updates: does NOT change slug (slug is stable after first save)', () => {
    const n = saveNote(db, nd, { mode: 'create', body: '# Old Title', type: 'claim' })
    expect(n.slug).toBe('old title')
    const updated = saveNote(db, nd, {
      mode: 'update',
      id: n.id,
      body: '# New Title',
      type: 'claim',
    })
    expect(updated.slug).toBe('old title')
  })

  it('soft-deletes outbound links rows of a deleted note', () => {
    const n = saveNote(db, nd, { mode: 'create', body: 'a [[x]]', type: 'claim' })
    saveNote(db, nd, { mode: 'softDelete', id: n.id })
    expect(db.prepare('SELECT COUNT(*) AS c FROM links WHERE from_note_id = ?').get(n.id)).toEqual({
      c: 0,
    })
  })

  it('update on a soft-deleted note un-deletes both DB row and file frontmatter', () => {
    const n = saveNote(db, nd, { mode: 'create', body: '# Foo\n\nv1', type: 'claim' })
    saveNote(db, nd, { mode: 'softDelete', id: n.id })
    const revived = saveNote(db, nd, {
      mode: 'update',
      id: n.id,
      body: '# Foo\n\nv2',
      type: 'claim',
    })
    expect(revived.deleted_at).toBe(null)
    const file = nd.readNote(n.id)
    expect(file.ok).toBe(true)
    if (file.ok) expect(file.frontmatter.deleted_at).toBeUndefined()
  })
})
