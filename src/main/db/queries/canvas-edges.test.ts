// @vitest-environment node
/**
 * Both-endpoints-placed edge query for read-only canvas edges (spec §11).
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { MANUAL_ARRANGEMENT_ID, ROOT_CANVAS_ID } from '../../../shared/canvas'
import { openDb } from '../client'
import { runMigrations } from '../migrate'
import { canvasEdges } from './canvas-edges'
import { placeNote } from './layouts'

type DB = ReturnType<typeof openDb>
let db: DB
const K = { canvasId: ROOT_CANVAS_ID, arrangementId: MANUAL_ARRANGEMENT_ID }

function seedNote(id: string, slug: string): void {
  db.prepare(
    `INSERT INTO notes (id, slug, body, type, created_at, updated_at)
     VALUES (?, ?, 'b', 'claim', 1, 1)`,
  ).run(id, slug)
}
function link(from: string, toSlug: string, type = 'reference'): void {
  db.prepare(`INSERT INTO links (from_note_id, to_slug, edge_type) VALUES (?, ?, ?)`).run(
    from,
    toSlug,
    type,
  )
}

beforeEach(() => {
  db = openDb(':memory:')
  runMigrations(db)
  seedNote('a', 'alpha')
  seedNote('b', 'beta')
  seedNote('c', 'gamma')
})

describe('canvasEdges', () => {
  it('returns an edge only when BOTH endpoints are placed', () => {
    link('a', 'beta')
    expect(canvasEdges(db, K)).toEqual([]) // neither placed
    placeNote(db, { ...K, noteId: 'a', x: 0, y: 0 })
    expect(canvasEdges(db, K)).toEqual([]) // target not placed
    placeNote(db, { ...K, noteId: 'b', x: 9, y: 9 })
    expect(canvasEdges(db, K)).toEqual([
      { fromNoteId: 'a', toNoteId: 'b', edgeType: 'reference', toSlug: 'beta' },
    ])
  })

  it('shelved endpoints do not count as placed', () => {
    link('a', 'beta')
    placeNote(db, { ...K, noteId: 'a', x: 0, y: 0 })
    db.prepare(`UPDATE node_layouts SET x = NULL, y = NULL WHERE note_id = 'a'`).run()
    placeNote(db, { ...K, noteId: 'b', x: 1, y: 1 })
    expect(canvasEdges(db, K)).toEqual([])
  })

  it('dangling slugs and soft-deleted targets draw nothing (spec §11)', () => {
    link('a', 'nope') // dangling
    link('a', 'gamma')
    placeNote(db, { ...K, noteId: 'a', x: 0, y: 0 })
    placeNote(db, { ...K, noteId: 'c', x: 1, y: 1 })
    db.prepare(`UPDATE notes SET deleted_at = 99 WHERE id = 'c'`).run()
    expect(canvasEdges(db, K)).toEqual([])
  })

  it('carries edge_type through (comment-on vs reference)', () => {
    link('a', 'beta', 'comment-on')
    placeNote(db, { ...K, noteId: 'a', x: 0, y: 0 })
    placeNote(db, { ...K, noteId: 'b', x: 1, y: 1 })
    expect(canvasEdges(db, K)).toEqual([
      { fromNoteId: 'a', toNoteId: 'b', edgeType: 'comment-on', toSlug: 'beta' },
    ])
  })
})
