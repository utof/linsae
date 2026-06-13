// @vitest-environment node
/**
 * Full canvas data-layer lifecycle against a real on-disk SQLite file —
 * mirrors file-db-roundtrip.test.ts posture (mkdtempSync, real fsync path).
 * @see docs/specs/v0.4-canvas-mvp.md §1 §2
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDb } from '../../src/main/db/client'
import { runMigrations } from '../../src/main/db/migrate'
import { getCanvasState, setCanvasState } from '../../src/main/db/queries/canvas-state'
import {
  listLayouts,
  moveNotes,
  placeNote,
  removeNotes,
  restoreLayouts,
  shelveNote,
} from '../../src/main/db/queries/layouts'
import { MANUAL_ARRANGEMENT_ID, ROOT_CANVAS_ID } from '../../src/shared/canvas'

const K = { canvasId: ROOT_CANVAS_ID, arrangementId: MANUAL_ARRANGEMENT_ID }
let dir: string
let db: ReturnType<typeof openDb>

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'linsae-canvas-'))
  db = openDb(join(dir, 'test.db'))
  runMigrations(db)
  db.prepare(
    `INSERT INTO notes (id, slug, body, type, created_at, updated_at)
     VALUES ('n1', 's1', 'b', 'claim', 1, 1)`,
  ).run()
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('canvas data-layer round-trip (real file)', () => {
  it('shelve → place → move → remove → restore survives a close/reopen', () => {
    shelveNote(db, { ...K, noteId: 'n1' })
    placeNote(db, { ...K, noteId: 'n1', x: 10, y: 20 })
    moveNotes(db, { ...K, moves: [{ noteId: 'n1', x: 30, y: 40 }] })
    const row = listLayouts(db, K)[0]!
    removeNotes(db, { ...K, noteIds: ['n1'] })
    restoreLayouts(db, {
      ...K,
      rows: [
        { noteId: 'n1', x: row.x, y: row.y, createdAt: row.created_at, placedAt: row.placed_at },
      ],
    })
    setCanvasState(db, ROOT_CANVAS_ID, { camera_x: 5, camera_y: 6, zoom: 1.5 })

    db.close()
    db = openDb(join(dir, 'test.db'))
    expect(listLayouts(db, K)).toMatchObject([{ note_id: 'n1', x: 30, y: 40 }])
    expect(getCanvasState(db, ROOT_CANVAS_ID)).toEqual({ camera_x: 5, camera_y: 6, zoom: 1.5 })
  })
})
