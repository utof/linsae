// @vitest-environment node
/**
 * Verifies the 0003 migration: node_layouts + canvas_state shape, the
 * x/y-null pairing CHECK, FK CASCADE, and no redundant canvas index.
 * @see docs/specs/v0.4-canvas-mvp.md §1
 */
import { describe, expect, it } from 'vitest'
import { openDb } from '../../src/main/db/client'
import { runMigrations } from '../../src/main/db/migrate'
import { MANUAL_ARRANGEMENT_ID, ROOT_CANVAS_ID } from '../../src/shared/canvas'

function colNames(db: ReturnType<typeof openDb>, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((r) => r.name)
}

function seedNote(db: ReturnType<typeof openDb>, id: string): void {
  db.prepare(
    `INSERT INTO notes (id, slug, body, type, created_at, updated_at)
     VALUES (?, ?, 'b', 'claim', 1, 1)`,
  ).run(id, `slug-${id}`)
}

describe('0003_canvas migration', () => {
  it('creates node_layouts and canvas_state with the expected columns', () => {
    const db = openDb(':memory:')
    runMigrations(db)
    expect(colNames(db, 'node_layouts').sort()).toEqual(
      [
        'arrangement_id',
        'canvas_id',
        'created_at',
        'note_id',
        'placed_at',
        'updated_at',
        'x',
        'y',
      ].sort(),
    )
    expect(colNames(db, 'canvas_state').sort()).toEqual(
      ['camera_x', 'camera_y', 'canvas_id', 'updated_at', 'zoom'].sort(),
    )
    db.close()
  })

  it('CHECK rejects x set without y (and vice versa)', () => {
    const db = openDb(':memory:')
    runMigrations(db)
    seedNote(db, 'n1')
    const ins = db.prepare(
      `INSERT INTO node_layouts (canvas_id, arrangement_id, note_id, x, y, created_at, updated_at)
       VALUES (@cid, @aid, 'n1', @x, @y, 1, 1)`,
    )
    const base = { cid: ROOT_CANVAS_ID, aid: MANUAL_ARRANGEMENT_ID }
    expect(() => ins.run({ ...base, x: 5, y: null })).toThrow(/CHECK/)
    expect(() => ins.run({ ...base, x: null, y: 5 })).toThrow(/CHECK/)
    expect(() => ins.run({ ...base, x: null, y: null })).not.toThrow()
    db.close()
  })

  it('hard-deleting a note CASCADEs its layout rows', () => {
    const db = openDb(':memory:')
    runMigrations(db)
    seedNote(db, 'n1')
    db.prepare(
      `INSERT INTO node_layouts (canvas_id, arrangement_id, note_id, x, y, created_at, updated_at)
       VALUES (?, ?, 'n1', 1, 2, 1, 1)`,
    ).run(ROOT_CANVAS_ID, MANUAL_ARRANGEMENT_ID)
    db.prepare(`DELETE FROM notes WHERE id = 'n1'`).run()
    expect(db.prepare(`SELECT COUNT(*) AS c FROM node_layouts`).get()).toEqual({ c: 0 })
    db.close()
  })

  it('adds no extra index on node_layouts (PK prefix suffices — spec §1)', () => {
    const db = openDb(':memory:')
    runMigrations(db)
    const idx = db.prepare(`PRAGMA index_list(node_layouts)`).all() as { origin: string }[]
    expect(idx.filter((i) => i.origin !== 'pk')).toEqual([])
    db.close()
  })
})
