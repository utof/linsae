// @vitest-environment node
/**
 * Layout wrappers: shelf/place lifecycle, liveness guards, undo support ops.
 * @see docs/specs/v0.4-canvas-mvp.md §1, §2, §13
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { MANUAL_ARRANGEMENT_ID, ROOT_CANVAS_ID } from '../../../shared/canvas'
import { openDb } from '../client'
import { runMigrations } from '../migrate'
import {
  deleteLayoutsForNote,
  listLayouts,
  moveNotes,
  placeNote,
  recentOnCanvas,
  removeNotes,
  restoreLayouts,
  shelveNote,
  unplaceNotes,
} from './layouts'

type DB = ReturnType<typeof openDb>
let db: DB
const K = { canvasId: ROOT_CANVAS_ID, arrangementId: MANUAL_ARRANGEMENT_ID }

function seedNote(id: string, at = 1000): void {
  db.prepare(
    `INSERT INTO notes (id, slug, body, type, created_at, updated_at)
     VALUES (?, ?, 'b', 'claim', ?, ?)`,
  ).run(id, `slug-${id}`, at, at)
}

beforeEach(() => {
  db = openDb(':memory:')
  runMigrations(db)
})

describe('shelveNote / placeNote lifecycle', () => {
  it('shelve creates an unplaced row; re-shelve is a no-op (placed row untouched)', () => {
    seedNote('n1')
    shelveNote(db, { ...K, noteId: 'n1' })
    expect(listLayouts(db, K)).toMatchObject([{ note_id: 'n1', x: null, placed_at: null }])
    placeNote(db, { ...K, noteId: 'n1', x: 10, y: 20 })
    shelveNote(db, { ...K, noteId: 'n1' }) // INSERT OR IGNORE — must not unplace
    expect(listLayouts(db, K)).toMatchObject([{ note_id: 'n1', x: 10, y: 20 }])
  })

  it('placeNote sets placed_at only when currently NULL (spec §2)', () => {
    seedNote('n1')
    placeNote(db, { ...K, noteId: 'n1', x: 1, y: 1 })
    const first = listLayouts(db, K)[0]!.placed_at
    expect(first).not.toBeNull()
    placeNote(db, { ...K, noteId: 'n1', x: 9, y: 9 })
    expect(listLayouts(db, K)[0]!.placed_at).toBe(first) // unchanged on re-place
  })

  it('skips dead notes (liveness guard, spec §2)', () => {
    seedNote('n1')
    db.prepare(`UPDATE notes SET deleted_at = 2000 WHERE id = 'n1'`).run()
    shelveNote(db, { ...K, noteId: 'n1' })
    placeNote(db, { ...K, noteId: 'n1', x: 1, y: 1 })
    expect(listLayouts(db, K)).toEqual([])
    // raw-table assert: pins the WHERE-liveness guard itself, not just the
    // listLayouts join (which would hide rows either way)
    expect(db.prepare(`SELECT COUNT(*) AS c FROM node_layouts`).get()).toEqual({ c: 0 })
  })
})

describe('moveNotes / unplaceNotes / removeNotes / restoreLayouts', () => {
  it('moveNotes updates positions transactionally; ignores shelved rows', () => {
    seedNote('a')
    seedNote('b')
    placeNote(db, { ...K, noteId: 'a', x: 0, y: 0 })
    shelveNote(db, { ...K, noteId: 'b' })
    moveNotes(db, {
      ...K,
      moves: [
        { noteId: 'a', x: 5, y: 6 },
        { noteId: 'b', x: 7, y: 8 },
      ],
    })
    const rows = listLayouts(db, K)
    expect(rows.find((r) => r.note_id === 'a')).toMatchObject({ x: 5, y: 6 })
    expect(rows.find((r) => r.note_id === 'b')).toMatchObject({ x: null }) // move ≠ place
  })

  it('unplaceNotes returns rows to the shelf: x/y/placed_at all NULL (spec §4)', () => {
    seedNote('a')
    placeNote(db, { ...K, noteId: 'a', x: 1, y: 2 })
    unplaceNotes(db, { ...K, noteIds: ['a'] })
    expect(listLayouts(db, K)).toMatchObject([{ note_id: 'a', x: null, y: null, placed_at: null }])
  })

  it('removeNotes deletes rows; restoreLayouts re-inserts preserving timestamps (undo, spec §13)', () => {
    seedNote('a')
    placeNote(db, { ...K, noteId: 'a', x: 1, y: 2 })
    const row = listLayouts(db, K)[0]!
    removeNotes(db, { ...K, noteIds: ['a'] })
    expect(listLayouts(db, K)).toEqual([])
    restoreLayouts(db, {
      ...K,
      rows: [
        { noteId: 'a', x: row.x, y: row.y, createdAt: row.created_at, placedAt: row.placed_at },
      ],
    })
    expect(listLayouts(db, K)).toMatchObject([
      { note_id: 'a', x: 1, y: 2, created_at: row.created_at, placed_at: row.placed_at },
    ])
  })

  it('restoreLayouts skips notes deleted since (no resurrection, spec §13)', () => {
    seedNote('a')
    placeNote(db, { ...K, noteId: 'a', x: 1, y: 2 })
    removeNotes(db, { ...K, noteIds: ['a'] })
    db.prepare(`UPDATE notes SET deleted_at = 3000 WHERE id = 'a'`).run()
    restoreLayouts(db, { ...K, rows: [{ noteId: 'a', x: 1, y: 2, createdAt: 1, placedAt: 1 }] })
    expect(listLayouts(db, K)).toEqual([])
    // raw-table assert: the row must not exist at all (no resurrection)
    expect(db.prepare(`SELECT COUNT(*) AS c FROM node_layouts`).get()).toEqual({ c: 0 })
  })
})

describe('deleteLayoutsForNote + recentOnCanvas', () => {
  it('deleteLayoutsForNote purges across all canvases/arrangements', () => {
    seedNote('a')
    placeNote(db, { ...K, noteId: 'a', x: 1, y: 1 })
    placeNote(db, {
      canvasId: 'other',
      arrangementId: MANUAL_ARRANGEMENT_ID,
      noteId: 'a',
      x: 2,
      y: 2,
    })
    deleteLayoutsForNote(db, 'a')
    expect(db.prepare(`SELECT COUNT(*) AS c FROM node_layouts`).get()).toEqual({ c: 0 })
  })

  it('recentOnCanvas: kind precedence edited > placed, created only on equal stamps (spec §2)', () => {
    seedNote('created-here', 5000)
    // creation transaction stamps created_at = updated_at = placed_at (spec §7)
    db.prepare(
      `INSERT INTO node_layouts (canvas_id, arrangement_id, note_id, x, y, created_at, placed_at, updated_at)
       VALUES (?, ?, 'created-here', 0, 0, 5000, 5000, 5000)`,
    ).run(ROOT_CANVAS_ID, MANUAL_ARRANGEMENT_ID)
    seedNote('edited-later', 1000)
    db.prepare(`UPDATE notes SET updated_at = 9000 WHERE id = 'edited-later'`).run()
    placeNote(db, { ...K, noteId: 'edited-later', x: 1, y: 1 }) // placed_at = Date.now() > 9000
    seedNote('just-placed', 1000)
    placeNote(db, { ...K, noteId: 'just-placed', x: 2, y: 2 })

    const entries = recentOnCanvas(db, { ...K, limit: 10 })
    const byId = Object.fromEntries(entries.map((e) => [e.noteId, e]))
    expect(byId['created-here']!.kind).toBe('created')
    expect(byId['edited-later']!.kind).toBe('placed') // placed_at(now) > updated_at(9000)
    expect(byId['just-placed']!.kind).toBe('placed')
    // ordering: at desc
    expect(entries.map((e) => e.at)).toEqual([...entries.map((e) => e.at)].sort((x, y) => y - x))
  })

  it('recentOnCanvas reports edited when updated_at exceeds placed_at', () => {
    seedNote('a', 1000)
    placeNote(db, { ...K, noteId: 'a', x: 1, y: 1 })
    const future = Date.now() + 60_000
    db.prepare(`UPDATE notes SET updated_at = ? WHERE id = 'a'`).run(future)
    const e = recentOnCanvas(db, { ...K, limit: 10 })[0]!
    expect(e).toMatchObject({ noteId: 'a', kind: 'edited', at: future })
  })
})
