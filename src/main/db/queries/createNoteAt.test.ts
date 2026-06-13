// @vitest-environment node
/**
 * createNoteAt runs ONE transaction with ONE timestamp so notes.created_at =
 * notes.updated_at = node_layouts.placed_at to the ms — the §2 recency rule's
 * 'created' detection depends on this (layouts.ts:193). Verified end-to-end
 * against the real recentOnCanvas query.
 * @see docs/specs/v0.4-canvas-mvp.md §7 §2
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NotesDir } from '../../files/notes-dir'
import { openDb } from '../client'
import { runMigrations } from '../migrate'
import { createNoteAt, recentOnCanvas } from './layouts'

type DB = ReturnType<typeof openDb>
let db: DB
let dir: string
let nd: NotesDir

beforeEach(() => {
  db = openDb(':memory:')
  runMigrations(db)
  dir = mkdtempSync(join(tmpdir(), 'linsae-canvas-'))
  nd = new NotesDir(dir)
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('createNoteAt (single-timestamp)', () => {
  it('stamps created_at = updated_at = placed_at and reads back as kind:created', () => {
    const note = createNoteAt(db, nd, {
      canvasId: 'root',
      arrangementId: 'manual',
      body: '# hello canvas',
      type: 'claim',
      x: 120,
      y: 240,
    })
    expect(note.created_at).toBe(note.updated_at)
    const row = db
      .prepare('SELECT x, y, placed_at, created_at FROM node_layouts WHERE note_id = ?')
      .get(note.id) as { x: number; y: number; placed_at: number; created_at: number }
    expect(row.x).toBe(120)
    expect(row.y).toBe(240)
    expect(row.placed_at).toBe(note.created_at)
    expect(row.created_at).toBe(note.created_at)
    const recent = recentOnCanvas(db, { canvasId: 'root', arrangementId: 'manual', limit: 8 })
    expect(recent.find((r) => r.noteId === note.id)?.kind).toBe('created')
  })
})
