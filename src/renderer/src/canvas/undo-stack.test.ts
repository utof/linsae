/**
 * Spatial-undo reducer (spec §13). Pure: no IPC, no liveness check (the IPC
 * layer re-checks liveness — §2 — so a stale undo can never resurrect a dead
 * note's rows). 100-entry cap, redo cleared on push, nudge-burst coalescing.
 * @see docs/specs/v0.4-canvas-mvp.md §13
 */
import { describe, expect, it } from 'vitest'
import {
  COALESCE_MS,
  emptyUndo,
  type Pos,
  pushOp,
  redo,
  type UndoEntry,
  type UndoItem,
  type UndoState,
  undo,
} from './undo-stack'

const place = (id: string): UndoEntry => ({
  op: 'place',
  items: [{ noteId: id, from: 'shelf' as Pos, to: { x: 1, y: 2 } } satisfies UndoItem],
})
const move = (id: string, at: number): UndoEntry => ({
  op: 'move',
  at,
  items: [{ noteId: id, from: { x: 0, y: 0 }, to: { x: 10, y: 10 } } satisfies UndoItem],
})

describe('undo-stack reducer', () => {
  it('pushOp appends and clears redo', () => {
    let s: UndoState = emptyUndo()
    s = pushOp(s, place('a'))
    const afterUndo = undo(s)
    s = afterUndo.state
    expect(afterUndo.entry).toEqual(place('a'))
    // a fresh push after an undo clears the redo branch
    s = pushOp(s, place('b'))
    expect(redo(s).entry).toBeNull() // redo branch was cleared
  })

  it('undo then redo returns the same entry and is symmetric', () => {
    const s = pushOp(emptyUndo(), place('a'))
    const u = undo(s)
    expect(u.entry).toEqual(place('a'))
    const r = redo(u.state)
    expect(r.entry).toEqual(place('a'))
    // back to a state where undo again yields the entry
    expect(undo(r.state).entry).toEqual(place('a'))
  })

  it('undo/redo on an empty branch returns null and an unchanged state', () => {
    const s = emptyUndo()
    expect(undo(s).entry).toBeNull()
    expect(undo(s).state).toBe(s)
    expect(redo(s).entry).toBeNull()
    expect(redo(s).state).toBe(s)
  })

  it('coalesces consecutive move ops on the same id-set within COALESCE_MS', () => {
    const t0 = 1000
    let s = pushOp(emptyUndo(), move('a', t0))
    s = pushOp(s, move('a', t0 + COALESCE_MS - 200)) // within window, same id → coalesced
    // one entry whose `from` is the FIRST move's from, `to` is the LAST move's to
    const u = undo(s)
    expect(u.entry?.items).toEqual([{ noteId: 'a', from: { x: 0, y: 0 }, to: { x: 10, y: 10 } }])
    expect(undo(u.state).entry).toBeNull() // only one entry total
  })

  it('does NOT coalesce moves past COALESCE_MS or on a different id-set', () => {
    const t0 = 1000
    let s = pushOp(emptyUndo(), move('a', t0))
    s = pushOp(s, move('a', t0 + COALESCE_MS * 2)) // past window → separate
    s = pushOp(s, move('b', t0 + COALESCE_MS * 2 + 100)) // different id → separate
    expect(undo(s).entry?.items[0]?.noteId).toBe('b')
  })

  it('caps the stack at 100 entries (oldest dropped)', () => {
    let s = emptyUndo()
    for (let i = 0; i < 130; i++) s = pushOp(s, place(`n${i}`))
    let count = 0
    let cur = s
    while (undo(cur).entry) {
      cur = undo(cur).state
      count++
    }
    expect(count).toBe(100)
  })
})
