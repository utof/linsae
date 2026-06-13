// @vitest-environment node
/**
 * Integration tests for drawn-edge create/delete (spec §1 §2 §8):
 *
 * 1. THE TRAP — a drawn edge SURVIVES a note save (replaceLinksForNote rebuilds
 *    only 'reference' rows; the drawn edge uses a non-reserved type so it is
 *    untouched). This test targets save-note.ts:228 directly.
 * 2. createEdge / deleteEdge round-trip; canvasEdges returns the edge when both placed.
 * 3. deleteEdge refuses 'reference'/'comment-on'.
 * 4. Soft-deleting an endpoint HIDES the drawn edge (canvasEdges omits it)
 *    but the row persists (orphan posture — spec §1 "Soft-delete posture").
 *
 * Uses real disk (mkdtempSync) + real SQLite file, mirroring the posture of
 * file-db-roundtrip.test.ts. saveNote is used for the trap test so the real
 * replaceLinksForNote path at save-note.ts:228 is exercised.
 *
 * @see docs/specs/v0.4.1-canvas-edges.md §1 §2 §8
 * @see src/main/save-note.ts:228 (replaceLinksForNote — the "trap" call site)
 * @see src/main/db/queries/links.ts:46 (replaceLinksForNote — scoped to 'reference')
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDb } from '../../src/main/db/client'
import { runMigrations } from '../../src/main/db/migrate'
import { canvasEdges } from '../../src/main/db/queries/canvas-edges'
import { createDrawnEdge, deleteDrawnEdge } from '../../src/main/db/queries/edges'
import { placeNote } from '../../src/main/db/queries/layouts'
import { NotesDir } from '../../src/main/files/notes-dir'
import { saveNote } from '../../src/main/save-note'
import { MANUAL_ARRANGEMENT_ID, ROOT_CANVAS_ID } from '../../src/shared/canvas'

const K = { canvasId: ROOT_CANVAS_ID, arrangementId: MANUAL_ARRANGEMENT_ID }

let dir: string
let notesDir: string
let db: ReturnType<typeof openDb>
let nd: NotesDir

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'linsae-edges-int-'))
  notesDir = join(dir, 'notes')
  db = openDb(join(dir, 'test.db'))
  runMigrations(db)
  nd = new NotesDir(notesDir)
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('canvas-edges integration', () => {
  it('THE TRAP: drawn edge survives a save of its source note while reference rows rebuild', () => {
    // Seed note A with a [[b]] wikilink and note B; both live.
    const noteA = saveNote(db, nd, {
      mode: 'create',
      body: '# A\n\n[[b]] wikilink reference',
      type: 'claim',
    })
    const noteB = saveNote(db, nd, {
      mode: 'create',
      body: '# B\n\nbody',
      type: 'claim',
    })

    // Draw an edge A→B with a non-reserved type.
    createDrawnEdge(db, { fromNoteId: noteA.id, toNoteId: noteB.id, edgeType: 'supports' })

    // Verify pre-save state: both 'reference' (wikilink) and 'supports' (drawn) exist.
    const preSave = db
      .prepare(`SELECT edge_type FROM links WHERE from_note_id=? ORDER BY edge_type`)
      .all(noteA.id) as { edge_type: string }[]
    expect(preSave.map((r) => r.edge_type).sort()).toEqual(['reference', 'supports'])

    // Update note A — this calls replaceLinksForNote(A, wikilinks) at save-note.ts:228.
    // That call deletes only edge_type='reference' rows and re-inserts from the body.
    saveNote(db, nd, {
      mode: 'update',
      id: noteA.id,
      body: '# A\n\n[[b]] wikilink reference (updated)',
      type: 'claim',
    })

    // After save: reference row rebuilt from wikilinks; 'supports' drawn edge SURVIVES.
    const postSave = db
      .prepare(`SELECT edge_type FROM links WHERE from_note_id=? ORDER BY edge_type`)
      .all(noteA.id) as { edge_type: string }[]
    expect(postSave.map((r) => r.edge_type).sort()).toEqual(['reference', 'supports'])
  })

  it('createEdge→deleteEdge round-trips; canvasEdges returns the drawn edge when both placed', () => {
    const noteA = saveNote(db, nd, { mode: 'create', body: '# A', type: 'claim' })
    const noteB = saveNote(db, nd, { mode: 'create', body: '# B', type: 'claim' })

    // Place both notes so canvasEdges can see them.
    placeNote(db, { ...K, noteId: noteA.id, x: 0, y: 0 })
    placeNote(db, { ...K, noteId: noteB.id, x: 100, y: 100 })

    createDrawnEdge(db, { fromNoteId: noteA.id, toNoteId: noteB.id, edgeType: 'link' })

    // canvasEdges should return the drawn edge.
    const edges = canvasEdges(db, K)
    expect(edges.some((e) => e.fromNoteId === noteA.id && e.edgeType === 'link')).toBe(true)

    // Delete it.
    const toSlug = noteB.slug
    deleteDrawnEdge(db, { fromNoteId: noteA.id, toSlug, edgeType: 'link' })

    const afterDelete = canvasEdges(db, K)
    expect(afterDelete.some((e) => e.fromNoteId === noteA.id && e.edgeType === 'link')).toBe(false)
  })

  it('deleteEdge refuses reference/comment-on', () => {
    const noteA = saveNote(db, nd, { mode: 'create', body: '# A', type: 'claim' })

    expect(() =>
      deleteDrawnEdge(db, { fromNoteId: noteA.id, toSlug: 'b', edgeType: 'reference' }),
    ).toThrow()
    expect(() =>
      deleteDrawnEdge(db, { fromNoteId: noteA.id, toSlug: 'b', edgeType: 'comment-on' }),
    ).toThrow()
  })

  it('soft-deleting an endpoint HIDES the drawn edge (canvasEdges omits it) but the row persists', () => {
    const noteA = saveNote(db, nd, { mode: 'create', body: '# A', type: 'claim' })
    const noteB = saveNote(db, nd, { mode: 'create', body: '# B', type: 'claim' })

    placeNote(db, { ...K, noteId: noteA.id, x: 0, y: 0 })
    placeNote(db, { ...K, noteId: noteB.id, x: 100, y: 100 })

    createDrawnEdge(db, { fromNoteId: noteA.id, toNoteId: noteB.id, edgeType: 'link' })

    // Verify edge is visible before soft-delete.
    expect(canvasEdges(db, K).some((e) => e.fromNoteId === noteA.id)).toBe(true)

    // Soft-delete B — replaceLinksForNote(B, []) runs but only clears B's FROM-rows
    // (edge_type='reference'); our A→B drawn edge is FROM A, not FROM B, so survives in DB.
    saveNote(db, nd, { mode: 'softDelete', id: noteB.id })

    // canvasEdges joins deleted_at IS NULL on both ends → drawn edge is hidden.
    expect(canvasEdges(db, K).some((e) => e.fromNoteId === noteA.id)).toBe(false)

    // But the links row still exists (orphan row — spec §1 "Soft-delete posture").
    const rowCount = db
      .prepare(`SELECT count(*) c FROM links WHERE from_note_id=?`)
      .get(noteA.id) as { c: number }
    expect(rowCount.c).toBe(1)
  })
})
