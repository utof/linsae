// @vitest-environment node
/**
 * TDD tests for the wikilink resolver.
 *
 * Uses an in-memory SQLite DB seeded via runMigrations — no disk I/O.
 *
 * Why: native better-sqlite3 binding is incompatible with jsdom (Node ABI vs
 * browser-like sandbox). The `@vitest-environment node` directive overrides
 * the global jsdom default for this file.
 *
 * @see src/main/db/queries/resolver.ts
 * @see docs/plans/v0.1-rolling-feed-and-search.md §Task 16
 * @see docs/specs/v0.1-rolling-feed-and-search.md §Resolution rule (lines 212-219)
 */

import type Database from 'better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'
import { openDb } from '../client'
import { runMigrations } from '../migrate'
import { createNote } from './notes'
import { resolveWikilink } from './resolver'

type DB = Database.Database

let db: DB
beforeEach(() => {
  db = openDb(':memory:')
  runMigrations(db)
})

describe('resolveWikilink', () => {
  it('returns the matching note by slug', () => {
    createNote(db, {
      id: 'n1',
      slug: 'spectral sequences',
      body: '# Spectral Sequences',
      type: 'claim',
    })
    const r = resolveWikilink(db, 'spectral sequences')
    expect(r?.id).toBe('n1')
  })

  it('returns null when no match (dangling)', () => {
    expect(resolveWikilink(db, 'no such note')).toBe(null)
  })

  it('falls back to alias match', () => {
    createNote(db, { id: 'n1', slug: 'serre', body: '# Serre', type: 'claim' })
    db.prepare('INSERT INTO note_aliases (note_id, alias) VALUES (?, ?)').run(
      'n1',
      'spectral sequences',
    )
    const r = resolveWikilink(db, 'spectral sequences')
    expect(r?.id).toBe('n1')
  })

  it('alias collision: returns the most recently created match', async () => {
    createNote(db, { id: 'n_old', slug: 'a', body: 'a', type: 'claim' })
    db.prepare('INSERT INTO note_aliases (note_id, alias) VALUES (?, ?)').run('n_old', 'def')
    await new Promise((r) => setTimeout(r, 5))
    createNote(db, { id: 'n_new', slug: 'b', body: 'b', type: 'claim' })
    db.prepare('INSERT INTO note_aliases (note_id, alias) VALUES (?, ?)').run('n_new', 'def')
    const r = resolveWikilink(db, 'def')
    expect(r?.id).toBe('n_new')
  })

  it('excludes soft-deleted notes from resolution', () => {
    createNote(db, { id: 'n1', slug: 'a', body: 'a', type: 'claim' })
    db.prepare('UPDATE notes SET deleted_at = ? WHERE id = ?').run(Date.now(), 'n1')
    expect(resolveWikilink(db, 'a')).toBe(null)
  })
})
