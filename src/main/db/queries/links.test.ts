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
import { backlinks, replaceLinksForNote, setCommentOnEdge } from './links'
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

  it('replaceLinksForNote does NOT delete comment-on edges (only reference edges)', () => {
    // seed a note + a comment-on edge + a reference edge for the same source
    db.prepare(
      `INSERT INTO notes (id, slug, body, type, created_at, updated_at) VALUES ('c1','c1','b','claim',0,0)`,
    ).run()
    setCommentOnEdge(db, 'c1', 'video-slug')
    replaceLinksForNote(db, 'c1', [link('foo')])
    // re-running replace (as a save would) must keep the comment-on edge
    replaceLinksForNote(db, 'c1', [link('bar')])
    const rows = db
      .prepare(
        'SELECT to_slug, edge_type FROM links WHERE from_note_id = ? ORDER BY edge_type, to_slug',
      )
      .all('c1') as { to_slug: string; edge_type: string }[]
    expect(rows).toEqual([
      { to_slug: 'video-slug', edge_type: 'comment-on' },
      { to_slug: 'bar', edge_type: 'reference' },
    ])
  })

  it('setCommentOnEdge is idempotent (composite PK)', () => {
    db.prepare(
      `INSERT INTO notes (id, slug, body, type, created_at, updated_at) VALUES ('c2','c2','b','claim',0,0)`,
    ).run()
    setCommentOnEdge(db, 'c2', 'video-slug')
    setCommentOnEdge(db, 'c2', 'video-slug')
    const n = db
      .prepare(`SELECT COUNT(*) AS n FROM links WHERE from_note_id='c2' AND edge_type='comment-on'`)
      .get() as { n: number }
    expect(n.n).toBe(1)
  })
})
