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
import { insertAttachment } from './attachments'
import { backlinks, commentsForNote, replaceLinksForNote, setCommentOnEdge } from './links'
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

describe('commentsForNote', () => {
  // Shared base for attachment insertion
  const attachBase = {
    kind: 'screenshot' as const,
    base_sha256: 'sha-cm1',
    base_path: '/tmp/cm1.png',
    video_id: 'vid1',
    time_seconds: 45,
    width_px: 1920,
    height_px: 1080,
    device_pixel_ratio: 2,
  }

  it('returns only comment-on linked notes (not reference-linked ones)', () => {
    // video note
    const video = createNote(db, { id: 'video1', slug: 'video 1', body: '', type: 'source' })
    // comment-note linked via comment-on
    createNote(db, { id: 'cm1', slug: 'cm 1', body: 'a comment', type: 'claim' })
    setCommentOnEdge(db, 'cm1', video.slug)
    // wikilink reference to the video — must NOT appear in commentsForNote
    createNote(db, { id: 'ref1', slug: 'ref 1', body: '[[video 1]]', type: 'claim' })
    replaceLinksForNote(db, 'ref1', [
      { slug: 'video 1', display: 'video 1', section: null, raw: '[[video 1]]' },
    ])

    const results = commentsForNote(db, video.slug)
    expect(results.map((r) => r.note.id)).toEqual(['cm1'])
  })

  it('excludes soft-deleted comment-notes', () => {
    const video = createNote(db, { id: 'video2', slug: 'video 2', body: '', type: 'source' })
    createNote(db, { id: 'cm2', slug: 'cm 2', body: 'live comment', type: 'claim' })
    setCommentOnEdge(db, 'cm2', video.slug)
    const deleted = createNote(db, {
      id: 'cm3',
      slug: 'cm 3',
      body: 'deleted comment',
      type: 'claim',
    })
    setCommentOnEdge(db, 'cm3', video.slug)
    softDeleteNote(db, deleted.id)

    const results = commentsForNote(db, video.slug)
    expect(results.map((r) => r.note.id)).toEqual(['cm2'])
  })

  it('returns attachment for a comment-note that has one', () => {
    const video = createNote(db, { id: 'video3', slug: 'video 3', body: '', type: 'source' })
    const cm = createNote(db, { id: 'cm4', slug: 'cm 4', body: 'has screenshot', type: 'claim' })
    setCommentOnEdge(db, cm.id, video.slug)
    const att = insertAttachment(db, { ...attachBase, note_id: cm.id })

    const results = commentsForNote(db, video.slug)
    expect(results).toHaveLength(1)
    expect(results[0]?.attachment?.id).toBe(att.id)
    expect(results[0]?.attachment?.base_path).toBe('/tmp/cm1.png')
  })

  it('returns null attachment for a comment-note with no attachment', () => {
    const video = createNote(db, { id: 'video4', slug: 'video 4', body: '', type: 'source' })
    createNote(db, { id: 'cm5', slug: 'cm 5', body: 'no screenshot', type: 'claim' })
    setCommentOnEdge(db, 'cm5', video.slug)

    const results = commentsForNote(db, video.slug)
    expect(results).toHaveLength(1)
    expect(results[0]?.attachment).toBeNull()
  })

  it('excludes soft-deleted attachments', () => {
    const video = createNote(db, { id: 'video5', slug: 'video 5', body: '', type: 'source' })
    const cm = createNote(db, {
      id: 'cm6',
      slug: 'cm 6',
      body: 'deleted attachment',
      type: 'claim',
    })
    setCommentOnEdge(db, cm.id, video.slug)
    const att = insertAttachment(db, { ...attachBase, note_id: cm.id })
    // soft-delete the attachment
    db.prepare('UPDATE attachments SET deleted_at = 1 WHERE id = ?').run(att.id)

    const results = commentsForNote(db, video.slug)
    expect(results).toHaveLength(1)
    expect(results[0]?.attachment).toBeNull()
  })

  it('returns notes ordered by created_at ascending', () => {
    const video = createNote(db, { id: 'video6', slug: 'video 6', body: '', type: 'source' })
    // Insert with explicit created_at via raw SQL so ordering is deterministic
    db.prepare(
      `INSERT INTO notes (id, slug, body, type, created_at, updated_at) VALUES ('cm7','cm 7','b','claim',300,300)`,
    ).run()
    db.prepare(
      `INSERT INTO notes (id, slug, body, type, created_at, updated_at) VALUES ('cm8','cm 8','b','claim',100,100)`,
    ).run()
    setCommentOnEdge(db, 'cm7', video.slug)
    setCommentOnEdge(db, 'cm8', video.slug)

    const results = commentsForNote(db, video.slug)
    expect(results.map((r) => r.note.id)).toEqual(['cm8', 'cm7'])
  })

  it('parses source_locator JSON and returns it on the note', () => {
    const video = createNote(db, { id: 'video7', slug: 'video 7', body: '', type: 'source' })
    db.prepare(
      `INSERT INTO notes (id, slug, body, type, created_at, updated_at, source_kind, source_locator)
       VALUES ('cm9','cm 9','b','claim',0,0,'youtube','{"media":"youtube","video_id":"vid1","t":83}')`,
    ).run()
    setCommentOnEdge(db, 'cm9', video.slug)

    const results = commentsForNote(db, video.slug)
    expect(results[0]?.note.source_locator).toEqual({ media: 'youtube', video_id: 'vid1', t: 83 })
  })
})
