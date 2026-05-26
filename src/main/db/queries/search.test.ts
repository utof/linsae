// @vitest-environment node
/**
 * TDD tests for FTS5 full-text search query wrapper.
 *
 * Uses an in-memory SQLite DB seeded via runMigrations — no disk I/O.
 *
 * Why: native better-sqlite3 binding is incompatible with jsdom (Node ABI vs
 * browser-like sandbox). The `@vitest-environment node` directive overrides
 * the global jsdom default for this file.
 *
 * @see src/main/db/queries/search.ts
 * @see docs/plans/v0.1-rolling-feed-and-search.md §Task 15
 * @see docs/specs/v0.1-rolling-feed-and-search.md §Data model (notes_fts)
 * @see docs/specs/v0.1-rolling-feed-and-search.md §User-facing surfaces (command palette)
 */

import type Database from 'better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'
import { openDb } from '../client'
import { runMigrations } from '../migrate'
import { createNote, softDeleteNote } from './notes'
import { searchNotes } from './search'

type DB = Database.Database

let db: DB
beforeEach(() => {
  db = openDb(':memory:')
  runMigrations(db)
  createNote(db, { id: 'n1', slug: 'a', body: 'spectral sequences collapse on E_2', type: 'claim' })
  createNote(db, {
    id: 'n2',
    slug: 'b',
    body: 'fibrations and the homotopy lifting property',
    type: 'claim',
  })
  createNote(db, { id: 'n3', slug: 'c', body: 'spectral and homotopy together', type: 'claim' })
})

describe('searchNotes', () => {
  it('returns matching notes ranked by bm25', () => {
    const r = searchNotes(db, { query: 'spectral', limit: 50 })
    expect(r.length).toBeGreaterThan(0)
    expect(r.map((h) => h.note.id)).toContain('n1')
    expect(r.map((h) => h.note.id)).toContain('n3')
  })

  it('snippet is non-empty and contains the term', () => {
    const r = searchNotes(db, { query: 'fibrations', limit: 50 })
    expect(r.length).toBeGreaterThan(0)
    expect(r[0]!.snippet.toLowerCase()).toContain('fibrations')
  })

  it('returns empty when no match', () => {
    expect(searchNotes(db, { query: 'xyzzy', limit: 50 })).toEqual([])
  })

  it('respects limit', () => {
    expect(searchNotes(db, { query: 'spectral', limit: 1 }).length).toBe(1)
  })

  it('excludes soft-deleted notes from results (spec §Soft delete)', () => {
    softDeleteNote(db, 'n1')
    const ids = searchNotes(db, { query: 'spectral', limit: 50 }).map((h) => h.note.id)
    expect(ids).not.toContain('n1')
    expect(ids).toContain('n3')
  })

  it('handles queries with punctuation (apostrophe, parens) without throwing', () => {
    createNote(db, { id: 'n4', slug: 'd', body: "the O'Hara identity for f(x)", type: 'claim' })
    expect(() => searchNotes(db, { query: "O'Hara", limit: 50 })).not.toThrow()
    expect(() => searchNotes(db, { query: 'f(x)', limit: 50 })).not.toThrow()
  })
})
