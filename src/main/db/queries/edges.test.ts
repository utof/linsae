// @vitest-environment node
/**
 * Unit tests for drawn-edge create/delete wrappers (spec §1 §2).
 * Exercises reserved-word refusal, self-edge refusal, dead-endpoint skip,
 * slug resolution from toNoteId, and idempotent INSERT OR IGNORE.
 * @see docs/specs/v0.4.1-canvas-edges.md §1 §2
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { openDb } from '../client'
import { runMigrations } from '../migrate'
import { createDrawnEdge, deleteDrawnEdge, RESERVED_EDGE_TYPES } from './edges'

type DB = ReturnType<typeof openDb>
let db: DB

function seedNote(id: string, slug: string): void {
  db.prepare(
    `INSERT INTO notes (id, slug, body, type, created_at, updated_at)
     VALUES (?, ?, 'body', 'claim', 1, 1)`,
  ).run(id, slug)
}

beforeEach(() => {
  db = openDb(':memory:')
  runMigrations(db)
  seedNote('A', 'a')
  seedNote('B', 'b')
})

describe('createDrawnEdge', () => {
  it('inserts a links row with the given edge_type, slug resolved from toNoteId', () => {
    createDrawnEdge(db, { fromNoteId: 'A', toNoteId: 'B', edgeType: 'link' })
    const row = db.prepare(`SELECT * FROM links WHERE from_note_id='A'`).get() as {
      from_note_id: string
      to_slug: string
      edge_type: string
    }
    expect(row).toMatchObject({ from_note_id: 'A', to_slug: 'b', edge_type: 'link' })
  })

  it('is idempotent (INSERT OR IGNORE on the PK)', () => {
    createDrawnEdge(db, { fromNoteId: 'A', toNoteId: 'B', edgeType: 'link' })
    createDrawnEdge(db, { fromNoteId: 'A', toNoteId: 'B', edgeType: 'link' })
    const row = db.prepare(`SELECT count(*) c FROM links`).get() as { c: number }
    expect(row.c).toBe(1)
  })

  it('throws on a self-edge (from === resolved target)', () => {
    expect(() =>
      createDrawnEdge(db, { fromNoteId: 'A', toNoteId: 'A', edgeType: 'link' }),
    ).toThrow()
  })

  it('throws when either endpoint is soft-deleted', () => {
    db.prepare(`UPDATE notes SET deleted_at=1 WHERE id='B'`).run()
    expect(() =>
      createDrawnEdge(db, { fromNoteId: 'A', toNoteId: 'B', edgeType: 'link' }),
    ).toThrow()
  })

  it('throws on a reserved edge_type', () => {
    for (const t of RESERVED_EDGE_TYPES) {
      expect(() => createDrawnEdge(db, { fromNoteId: 'A', toNoteId: 'B', edgeType: t })).toThrow()
    }
  })
})

describe('deleteDrawnEdge', () => {
  it('deletes the exact PK row', () => {
    createDrawnEdge(db, { fromNoteId: 'A', toNoteId: 'B', edgeType: 'supports' })
    deleteDrawnEdge(db, { fromNoteId: 'A', toSlug: 'b', edgeType: 'supports' })
    const row = db.prepare(`SELECT count(*) c FROM links`).get() as { c: number }
    expect(row.c).toBe(0)
  })

  it('refuses to delete a reserved edge_type', () => {
    expect(() =>
      deleteDrawnEdge(db, { fromNoteId: 'A', toSlug: 'b', edgeType: 'reference' }),
    ).toThrow()
  })
})
