/**
 * Spatial-undo stack for the canvas (spec §13). A pure immutable value +
 * pure transitions — the renderer holds one in a ref, the IPC layer does the
 * actual layout writes when an entry is applied. Separate from any content/
 * text undo (vision principle 2; §Full undo is the persisted successor).
 *
 * `from`/`to` positions: `{x,y}` placed, `'shelf'` unplaced row, `'absent'`
 * no row. Apply mapping (done by the caller, not here): to undo, drive each
 * item from `to`→`from`; to redo, `from`→`to`.
 *  - `'shelf'`  → canvas:unplaceNotes
 *  - `'absent'` → canvas:removeNotes (forward) / canvas:restoreLayouts (back)
 *  - `{x,y}`    → canvas:placeNote / canvas:moveNotes
 * @see docs/specs/v0.4-canvas-mvp.md §13
 */
export type Pos = { x: number; y: number } | 'shelf' | 'absent'

export interface UndoItem {
  noteId: string
  from: Pos
  to: Pos
}

export interface UndoEntry {
  op: 'place' | 'move' | 'remove'
  items: UndoItem[]
  /** Epoch ms of the op; only `move` carries one (nudge-burst coalescing). */
  at?: number
}

export interface UndoState {
  past: UndoEntry[]
  future: UndoEntry[]
}

/** Max stack depth (spec §13). */
const CAP = 100
/** Nudge/move-burst coalescing window (spec §13: ~500 ms). */
export const COALESCE_MS = 500

export function emptyUndo(): UndoState {
  return { past: [], future: [] }
}

function sameIds(a: UndoEntry, b: UndoEntry): boolean {
  if (a.items.length !== b.items.length) return false
  const ids = new Set(a.items.map((i) => i.noteId))
  return b.items.every((i) => ids.has(i.noteId))
}

/**
 * Push a new op. Clears the redo branch. A `move` immediately following a
 * `move` on the same id-set within COALESCE_MS is merged into the prior entry
 * (its `from` is kept, the new `to` replaces) so a nudge burst is one undo.
 */
export function pushOp(s: UndoState, entry: UndoEntry): UndoState {
  const prev = s.past[s.past.length - 1]
  const coalesce =
    entry.op === 'move' &&
    prev?.op === 'move' &&
    entry.at !== undefined &&
    prev.at !== undefined &&
    entry.at - prev.at <= COALESCE_MS &&
    sameIds(prev, entry)
  if (coalesce && prev && entry.at !== undefined) {
    // Merge: keep each item's original `from`, take the new `to`.
    const byId = new Map(entry.items.map((i) => [i.noteId, i.to]))
    const merged: UndoEntry = {
      op: 'move',
      at: entry.at,
      items: prev.items.map((i) => ({ ...i, to: byId.get(i.noteId) ?? i.to })),
    }
    return { past: [...s.past.slice(0, -1), merged], future: [] }
  }
  const past = [...s.past, entry].slice(-CAP)
  return { past, future: [] }
}

/** Pop the newest past entry into the future branch. Returns it (or null). */
export function undo(s: UndoState): { state: UndoState; entry: UndoEntry | null } {
  const entry = s.past[s.past.length - 1]
  if (!entry) return { state: s, entry: null }
  return { state: { past: s.past.slice(0, -1), future: [...s.future, entry] }, entry }
}

/** Move the newest future entry back to the past branch. Returns it (or null). */
export function redo(s: UndoState): { state: UndoState; entry: UndoEntry | null } {
  const entry = s.future[s.future.length - 1]
  if (!entry) return { state: s, entry: null }
  return { state: { past: [...s.past, entry], future: s.future.slice(0, -1) }, entry }
}
