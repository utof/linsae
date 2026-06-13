/**
 * Survival tests for the spatial-undo store: the {@link UndoState} AND its
 * timestamp side-map must outlive a CanvasStage remount within the SAME window
 * session (= same QueryClient), dying only on window close (= a fresh cache).
 *
 * This is the §13 fix's falsifiable proof: a plain `useRef(emptyUndo())` resets
 * to empty on every remount; the cache write-through restores the flushed value.
 *
 * @see src/renderer/src/canvas/useSpatialUndoStore.ts
 * @see docs/specs/v0.4-canvas-mvp.md §13
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it } from 'vitest'
import type { LayoutTimestamps } from './CanvasStage'
import type { UndoEntry } from './undo-stack'
import { useSpatialUndoStore } from './useSpatialUndoStore'

/** Wrap renderHook in a provider bound to an EXPLICIT client so tests can reuse it. */
function wrapper(qc: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  )
}

const moveEntry: UndoEntry = {
  op: 'move',
  items: [{ noteId: 'n1', from: { x: 0, y: 0 }, to: { x: 40, y: 60 } }],
}

describe('useSpatialUndoStore', () => {
  it('restores undo state + timestamps across a remount on the same QueryClient', () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })

    // First mount: seed an undo entry + a timestamp side-map row, then persist.
    const first = renderHook(() => useSpatialUndoStore('root'), { wrapper: wrapper(qc) })
    first.result.current.undoRef.current = { past: [moveEntry], future: [] }
    first.result.current.timestampsRef.current.set('n1', { createdAt: 111, placedAt: 222 })
    first.result.current.persist()
    // Unmount → the cleanup flush write-through fires (belt-and-braces with persist).
    first.unmount()

    // Second mount on the SAME client: a fresh hook instance must re-read the
    // flushed value, not emptyUndo() — proving survival across the remount.
    const second = renderHook(() => useSpatialUndoStore('root'), { wrapper: wrapper(qc) })
    expect(second.result.current.undoRef.current).toEqual({ past: [moveEntry], future: [] })
    const ts: LayoutTimestamps = second.result.current.timestampsRef.current
    expect(ts.get('n1')).toEqual({ createdAt: 111, placedAt: 222 })
  })

  it('flushes on unmount even without an explicit persist() (mirrors camera cadence)', () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })

    const first = renderHook(() => useSpatialUndoStore('root'), { wrapper: wrapper(qc) })
    // Mutate the refs but DO NOT call persist — the unmount cleanup must flush.
    first.result.current.undoRef.current = { past: [moveEntry], future: [] }
    first.unmount()

    const second = renderHook(() => useSpatialUndoStore('root'), { wrapper: wrapper(qc) })
    expect(second.result.current.undoRef.current.past).toHaveLength(1)
  })

  it('a fresh QueryClient (window close) starts from an empty stack', () => {
    const qc1 = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const first = renderHook(() => useSpatialUndoStore('root'), { wrapper: wrapper(qc1) })
    first.result.current.undoRef.current = { past: [moveEntry], future: [] }
    first.result.current.persist()
    first.unmount()

    // A NEW client models a new window (in-memory cache gone → stack dies, §13).
    const qc2 = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const second = renderHook(() => useSpatialUndoStore('root'), { wrapper: wrapper(qc2) })
    expect(second.result.current.undoRef.current).toEqual({ past: [], future: [] })
    expect(second.result.current.timestampsRef.current.size).toBe(0)
  })
})
