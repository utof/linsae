/**
 * Per-window survival store for the canvas spatial-undo stack.
 *
 * Why: the feed↔canvas toggle renders CanvasStage inside an
 * `AnimatePresence mode="wait"` (App.tsx), so toggling to feed UNMOUNTS the
 * stage and toggling back MOUNTS a fresh instance. A plain `useRef(emptyUndo())`
 * would re-initialise to empty on every remount — arrange cards → toggle away →
 * toggle back → ⌘Z silently does nothing. Spec §13 says the stack is "per
 * window, dies on close"; a view toggle is NOT a window close. This hook makes
 * the {@link UndoState} AND its timestamp side-map survive a same-session remount
 * by mirroring {@link useCanvasCamera}'s mechanism: a write-through to a
 * react-query cache entry keyed by `canvasId`, flushed unconditionally on unmount
 * and `beforeunload`, re-read on mount.
 *
 * KEY DIFFERENCE from the camera: the camera ALSO persists to SQLite for
 * cross-restart survival; the undo stack must NOT — §13 says it dies on window
 * close (= page reload, which clears the in-memory query cache). So this is an
 * in-memory cache entry ONLY: no queryFn, no IPC, no disk.
 *
 * @see docs/specs/v0.4-canvas-mvp.md §13 (spatial undo — per window, dies on close)
 * @see src/renderer/src/canvas/useCanvasCamera.ts (the sibling survival pattern)
 */
import { useQueryClient } from '@tanstack/react-query'
import { type RefObject, useCallback, useEffect, useRef } from 'react'
import type { LayoutTimestamps } from './CanvasStage'
import { emptyUndo, type UndoState } from './undo-stack'

/**
 * The full undo view-state for one canvas: the reducer value plus the timestamp
 * side-map captured at remove time (so an undo's `restoreLayouts` reconstructs
 * rows with their ORIGINAL `created_at`/`placed_at` — §13). Bundled into ONE
 * cache value so both halves survive a remount together.
 */
interface SpatialUndoState {
  undo: UndoState
  timestamps: LayoutTimestamps
}

/** Cache key for the per-canvas in-memory undo store (no queryFn — view-state only). */
function undoKey(canvasId: string): [string, string] {
  return ['canvas-undo', canvasId]
}

export interface UseSpatialUndoStore {
  /** The live undo reducer value; mutate `.current` then call {@link persist}. */
  undoRef: RefObject<UndoState>
  /** The live timestamp side-map; mutate then call {@link persist}. */
  timestampsRef: RefObject<LayoutTimestamps>
  /** Write the current refs through to the survival cache (call after any mutation). */
  persist: () => void
}

/**
 * Restores the spatial-undo stack for `canvasId` from the survival cache on
 * mount (falling back to an empty stack), and registers the unconditional flush
 * on unmount + `beforeunload`. Callers mutate the returned refs in place and call
 * {@link UseSpatialUndoStore.persist} after each mutation — the same write-through
 * cadence {@link useCanvasCamera} uses, minus the debounce + IPC (no disk).
 *
 * Refs are initialised lazily from the cache so the FIRST render already sees the
 * flushed value (not empty-then-restore). `persist` and the refs are stable across
 * renders (ADR 0006 stable-ref posture).
 */
export function useSpatialUndoStore(canvasId: string): UseSpatialUndoStore {
  const queryClient = useQueryClient()

  // Lazy init from the survival cache: a same-session remount re-reads the
  // flushed value; a fresh window (cache empty) starts from emptyUndo().
  const undoRef = useRef<UndoState | null>(null)
  const timestampsRef = useRef<LayoutTimestamps | null>(null)
  if (undoRef.current === null) {
    const cached = queryClient.getQueryData<SpatialUndoState>(undoKey(canvasId))
    undoRef.current = cached?.undo ?? emptyUndo()
    timestampsRef.current = cached?.timestamps ?? new Map()
  }

  // persist write-throughs the live refs to the survival cache. A useCallback
  // with empty deps gives it a STABLE identity (ADR 0006) so the CanvasStage
  // callbacks that depend on it (recordOp/undo/redo) don't re-create each render.
  // queryClient is stable from useQueryClient; canvasId is constant in v0.4
  // (ROOT_CANVAS_ID) — the closure capture is safe.
  // biome-ignore lint/correctness/useExhaustiveDependencies: queryClient/canvasId are stable for the store's lifetime; the refs are mutated in place, never reassigned
  const persist = useCallback(() => {
    queryClient.setQueryData<SpatialUndoState>(undoKey(canvasId), {
      undo: undoRef.current as UndoState,
      timestamps: timestampsRef.current as LayoutTimestamps,
    })
  }, [])

  // Unconditional flush on app quit (beforeunload) and on unmount (view toggle) —
  // mirrors useCanvasCamera's flush effect, minus the IPC/disk write.
  useEffect(() => {
    const flush = () => persist()
    window.addEventListener('beforeunload', flush)
    return () => {
      window.removeEventListener('beforeunload', flush)
      flush()
    }
  }, [persist])

  return {
    undoRef: undoRef as RefObject<UndoState>,
    timestampsRef: timestampsRef as RefObject<LayoutTimestamps>,
    persist,
  }
}
