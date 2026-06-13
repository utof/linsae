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

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDb } from './db/client'
import { runMigrations } from './db/migrate'
import { backlinks } from './db/queries/links'
import { getNote } from './db/queries/notes'
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

  it('creates: rejects duplicate slug BEFORE writing file or DB row (no orphans)', () => {
    saveNote(db, nd, { mode: 'create', body: 'abc', type: 'claim' })
    const before = readdirSync(dir).length
    expect(() => saveNote(db, nd, { mode: 'create', body: 'abc', type: 'claim' })).toThrow(
      /a note named "abc" already exists/,
    )
    // No orphan .md file was written for the rejected attempt.
    expect(readdirSync(dir).length).toBe(before)
    // Exactly one row in the DB — the rejected attempt did not INSERT.
    expect(db.prepare('SELECT COUNT(*) AS c FROM notes').get()).toEqual({ c: 1 })
  })

  it('creates: a soft-deleted slug does NOT block a new note with the same slug', () => {
    const first = saveNote(db, nd, { mode: 'create', body: 'abc', type: 'claim' })
    saveNote(db, nd, { mode: 'softDelete', id: first.id })
    // After soft-delete, the partial unique index (WHERE deleted_at IS NULL) no
    // longer covers the row, so a fresh note with the same slug must be allowed.
    const second = saveNote(db, nd, { mode: 'create', body: 'abc', type: 'claim' })
    expect(second.slug).toBe('abc')
    expect(second.id).not.toBe(first.id)
    expect(existsSync(join(dir, `${second.id}.md`))).toBe(true)
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

  it('persists source_kind/source_locator to the DB and the file frontmatter', () => {
    const note = saveNote(db, nd, {
      mode: 'create',
      body: 'a video',
      type: 'source',
      source_kind: 'youtube',
      source_locator: { media: 'youtube', video_id: 'dQw4w9WgXcQ' },
    })
    const fetched = getNote(db, note.id)
    expect(fetched?.source_kind).toBe('youtube')
    expect(fetched?.source_locator).toEqual({ media: 'youtube', video_id: 'dQw4w9WgXcQ' })
    const file = nd.readNote(note.id)
    expect(file.ok && file.frontmatter.source_kind).toBe('youtube')
    expect(file.ok && file.frontmatter.source_locator).toEqual({
      media: 'youtube',
      video_id: 'dQw4w9WgXcQ',
    })
  })

  it('softDelete purges the note layout rows across canvases (spec v0.4 §1)', () => {
    const n = saveNote(db, nd, { mode: 'create', body: 'on canvas', type: 'claim' })
    db.prepare(
      `INSERT INTO node_layouts (canvas_id, arrangement_id, note_id, x, y, created_at, placed_at, updated_at)
       VALUES ('root', 'manual', ?, 1, 2, 1, 1, 1)`,
    ).run(n.id)
    saveNote(db, nd, { mode: 'softDelete', id: n.id })
    const count = db.prepare(`SELECT COUNT(*) AS c FROM node_layouts WHERE note_id = ?`).get(n.id)
    expect(count).toEqual({ c: 0 })
  })

  it('creates a comment-on edge to the video-note when commentOn is given', () => {
    // a video-note to comment on
    const video = saveNote(db, nd, {
      mode: 'create',
      body: '# Serre lecture',
      type: 'source',
      source_kind: 'youtube',
      source_locator: { media: 'youtube', video_id: 'vid123' },
    })
    const comment = saveNote(db, nd, {
      mode: 'create',
      body: 'great point at the pullback',
      type: 'claim',
      source_kind: 'youtube',
      source_locator: { media: 'youtube', video_id: 'vid123', t: 83 },
      commentOn: video.slug,
    })
    // backlinks(video.slug) should include the comment via the comment-on edge
    const back = backlinks(db, video.slug)
    expect(back.map((n) => n.id)).toContain(comment.id)
    // and a body re-save of the comment must NOT drop the edge (Task 11 scoping)
    saveNote(db, nd, { mode: 'update', id: comment.id, body: 'edited', type: 'claim' })
    expect(backlinks(db, video.slug).map((n) => n.id)).toContain(comment.id)
  })
})
