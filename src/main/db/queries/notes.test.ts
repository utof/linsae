// @vitest-environment node
/**
 * TDD tests for notes CRUD queries.
 * Uses an in-memory SQLite DB seeded via runMigrations — no disk I/O.
 *
 * Why: native better-sqlite3 binding is incompatible with jsdom (Node ABI vs
 * browser-like sandbox). The `@vitest-environment node` directive overrides
 * the global jsdom default for this file.
 *
 * @see src/main/db/queries/notes.ts
 * @see docs/plans/v0.1-rolling-feed-and-search.md §Task 13
 */

import type Database from 'better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'
import { openDb } from '../client'
import { runMigrations } from '../migrate'
import { createNote, getNote, listNotes, softDeleteNote, updateNote } from './notes'

type DB = Database.Database

let db: DB
beforeEach(() => {
  db = openDb(':memory:')
  runMigrations(db)
})

describe('notes queries', () => {
  it('createNote → getNote round trip', () => {
    const note = createNote(db, { id: 'n1', slug: 'foo', body: '# Foo\n\nbody', type: 'claim' })
    expect(note.id).toBe('n1')
    expect(note.created_at).toBeGreaterThan(0)
    const r = getNote(db, 'n1')
    expect(r?.body).toBe('# Foo\n\nbody')
  })

  it('listNotes returns notes in created_at order (oldest first per spec §User-facing surfaces)', () => {
    createNote(db, { id: 'n1', slug: 'a', body: 'a', type: 'claim' })
    createNote(db, { id: 'n2', slug: 'b', body: 'b', type: 'claim' })
    const list = listNotes(db, { limit: 10 })
    expect(list.map((n) => n.id)).toEqual(['n1', 'n2'])
  })

  it('listNotes excludes soft-deleted notes', () => {
    createNote(db, { id: 'n1', slug: 'a', body: 'a', type: 'claim' })
    createNote(db, { id: 'n2', slug: 'b', body: 'b', type: 'claim' })
    softDeleteNote(db, 'n1')
    expect(listNotes(db, { limit: 10 }).map((n) => n.id)).toEqual(['n2'])
  })

  it('updateNote updates body, type, updated_at', async () => {
    const before = createNote(db, { id: 'n1', slug: 'a', body: 'old', type: 'claim' })
    await new Promise((r) => setTimeout(r, 5))
    updateNote(db, { id: 'n1', body: 'new', type: 'question' })
    const after = getNote(db, 'n1')
    expect(after?.body).toBe('new')
    expect(after?.type).toBe('question')
    expect(after?.updated_at).toBeGreaterThan(before.updated_at)
  })

  it('listNotes(before) returns only notes strictly older than the cursor', () => {
    createNote(db, { id: 'n1', slug: 'a', body: 'a', type: 'claim' })
    // 2ms gap so n2.created_at > n1.created_at deterministically.
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        const n2 = createNote(db, { id: 'n2', slug: 'b', body: 'b', type: 'claim' })
        expect(listNotes(db, { limit: 10, before: n2.created_at }).map((n) => n.id)).toEqual(['n1'])
        resolve()
      }, 2)
    })
  })

  it('softDeleteNote sets deleted_at; getNote still returns it (for backlink history)', () => {
    createNote(db, { id: 'n1', slug: 'a', body: 'a', type: 'claim' })
    softDeleteNote(db, 'n1')
    const after = getNote(db, 'n1')
    expect(after?.deleted_at).not.toBeNull()
  })

  it('getNote hydrates source_kind and parses source_locator JSON', () => {
    db.prepare(
      `INSERT INTO notes (id, slug, body, type, created_at, updated_at, source_kind, source_locator)
       VALUES ('v1', 'v1', 'b', 'source', 0, 0, 'youtube', ?)`,
    ).run(JSON.stringify({ media: 'youtube', video_id: 'dQw4w9WgXcQ', t: 83 }))
    const n = getNote(db, 'v1')
    expect(n?.source_kind).toBe('youtube')
    expect(n?.source_locator).toEqual({ media: 'youtube', video_id: 'dQw4w9WgXcQ', t: 83 })
  })

  it('getNote returns null source fields for a plain note', () => {
    db.prepare(
      `INSERT INTO notes (id, slug, body, type, created_at, updated_at) VALUES ('p1','p1','b','claim',0,0)`,
    ).run()
    const n = getNote(db, 'p1')
    expect(n?.source_kind).toBeNull()
    expect(n?.source_locator).toBeNull()
  })
})
