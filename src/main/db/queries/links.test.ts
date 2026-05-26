// @vitest-environment node
/**
 * TDD tests for links table query wrappers.
 *
 * Uses an in-memory SQLite DB seeded via runMigrations — no disk I/O.
 *
 * Why: native better-sqlite3 binding is incompatible with jsdom (Node ABI vs
 * browser-like sandbox). The `@vitest-environment node` directive overrides
 * the global jsdom default for this file.
 *
 * @see src/main/db/queries/links.ts
 * @see docs/plans/v0.1-rolling-feed-and-search.md §Task 14
 * @see docs/specs/v0.1-rolling-feed-and-search.md §Backlinks query
 */

import type Database from 'better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Wikilink } from '../../text/wikilinks'
import { openDb } from '../client'
import { runMigrations } from '../migrate'
import { backlinks, replaceLinksForNote } from './links'
import { createNote, softDeleteNote } from './notes'

type DB = Database.Database

function link(slug: string): Wikilink {
  return { slug, display: slug, section: null, raw: `[[${slug}]]` }
}

let db: DB
beforeEach(() => {
  db = openDb(':memory:')
  runMigrations(db)
  createNote(db, { id: 'src1', slug: 'src 1', body: 'see [[target]]', type: 'claim' })
  createNote(db, { id: 'src2', slug: 'src 2', body: 'also [[target]]', type: 'claim' })
  createNote(db, { id: 'tgt', slug: 'target', body: '# target\n\nthe target', type: 'claim' })
})

describe('links queries', () => {
  it('replaceLinksForNote inserts rows; backlinks returns sources', () => {
    replaceLinksForNote(db, 'src1', [link('target')])
    replaceLinksForNote(db, 'src2', [link('target')])
    const r = backlinks(db, 'target')
    expect(r.map((n) => n.id).sort()).toEqual(['src1', 'src2'])
  })

  it('replaceLinksForNote replaces (not appends)', () => {
    replaceLinksForNote(db, 'src1', [link('target')])
    replaceLinksForNote(db, 'src2', [link('target')])
    replaceLinksForNote(db, 'src1', []) // user removed all links from src1
    expect(backlinks(db, 'target').map((n) => n.id)).toEqual(['src2'])
  })

  it('backlinks excludes soft-deleted source notes', () => {
    replaceLinksForNote(db, 'src1', [link('target')])
    softDeleteNote(db, 'src1')
    expect(backlinks(db, 'target').map((n) => n.id)).toEqual([])
  })
})
