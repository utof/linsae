/**
 * Headless transition tests for useCanvasInteractions. happy-dom has no
 * pointer/layout model, so the drag/marquee POINTER path is verified by the
 * Plan-4 Playwright harness — NOT here. This file asserts only the pure,
 * camera-free transitions that run headless: the selection set ops and the
 * nudge consumption rule (it composes the already-tested `selection-geometry`
 * helpers). It also gives the hook the knip reachability its Task-8 consumer
 * will provide on the branch — without faking pointers or a dead consumer.
 *
 * @see src/renderer/src/canvas/useCanvasInteractions.ts
 * @see docs/specs/v0.4-canvas-mvp.md §8
 */
import { act, renderHook } from '@testing-library/react'
import { createRef, type RefObject } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { Camera, Point } from './camera'
import { CardSpatialIndex, type WorldRect } from './spatial-index'
import { useCanvasInteractions } from './useCanvasInteractions'

/**
 * A minimal HTMLElement stand-in: the edge-gesture START path (Task 6) calls
 * `viewport.setPointerCapture` + `getBoundingClientRect`, and `onCardPointerDown`
 * early-returns when `viewportRef.current` is null — so the gesture tests must
 * supply a non-null viewport. happy-dom has no real pointer/layout model, so the
 * move→drop choreography is smoke-tested in Task 10, NOT here.
 */
function fakeViewport(): HTMLDivElement {
  return {
    setPointerCapture() {},
    releasePointerCapture() {},
    hasPointerCapture() {
      return true
    },
    // The hook's effect attaches native pointer listeners to the viewport node;
    // happy-dom never dispatches them in this file, so no-ops suffice.
    addEventListener() {},
    removeEventListener() {},
    getBoundingClientRect() {
      return { left: 0, top: 0, width: 1000, height: 800 } as DOMRect
    },
  } as unknown as HTMLDivElement
}

/** Build a synthetic React.PointerEvent with modifier keys defaulted off. */
const evt = (over: Partial<React.PointerEvent>) =>
  ({
    button: 0,
    pointerId: 1,
    clientX: 100,
    clientY: 100,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    preventDefault() {},
    stopPropagation() {},
    ...over,
  }) as unknown as React.PointerEvent

function setup(
  placed: Record<string, WorldRect> = {},
  opts: { viewport?: HTMLDivElement | null } = {},
) {
  const cameraRef: RefObject<Camera> = createRef() as RefObject<Camera>
  cameraRef.current = { x: 0, y: 0, zoom: 1 }
  const viewportRef = createRef<HTMLDivElement | null>()
  // Default to no viewport (the legacy imperative tests never touch pointers); the
  // gesture tests pass a fakeViewport so the START path runs.
  viewportRef.current = opts.viewport ?? null
  const placedRects = new Map(Object.entries(placed))
  const index = new CardSpatialIndex()
  for (const [id, rect] of placedRects) index.setCard(id, rect)
  const onCommitMove = vi.fn()
  const onCommitNudge = vi.fn<(m: { noteId: string; from: Point; to: Point }[]) => void>()
  const onCreateEdge = vi.fn()
  const onEdgeTargetPicker = vi.fn()
  const hitVisibleAt = vi.fn<(w: Point) => string | null>(() => null)
  const { result } = renderHook(() =>
    useCanvasInteractions({
      cameraRef,
      viewportRef,
      placedRects,
      index,
      onCommitMove,
      onCommitNudge,
      onCreateEdge,
      onEdgeTargetPicker,
      hitVisibleAt,
    }),
  )
  return { result, onCommitMove, onCommitNudge, onCreateEdge, onEdgeTargetPicker, hitVisibleAt }
}

/** Three cards laid out for the edge-gesture START tests. */
const EDGE_BOARD: Record<string, WorldRect> = {
  A: { x: 0, y: 0, w: 360, h: 140 },
  B: { x: 500, y: 0, w: 360, h: 140 },
  C: { x: 0, y: 300, w: 360, h: 140 },
}

describe('useCanvasInteractions (headless transitions)', () => {
  it('starts with an empty selection and no drag/marquee', () => {
    const { result } = setup()
    expect([...result.current.selectedIds]).toEqual([])
    expect(result.current.dragOffset).toBeNull()
    expect(result.current.marquee).toBeNull()
    expect(result.current.dragging).toBe(false)
  })

  it('setSelection replaces, toggleSelection adds then removes, clearSelection empties', () => {
    const { result } = setup()
    act(() => result.current.setSelection(['a', 'b']))
    expect(new Set(result.current.selectedIds)).toEqual(new Set(['a', 'b']))
    act(() => result.current.toggleSelection('c'))
    expect(new Set(result.current.selectedIds)).toEqual(new Set(['a', 'b', 'c']))
    act(() => result.current.toggleSelection('a'))
    expect(new Set(result.current.selectedIds)).toEqual(new Set(['b', 'c']))
    act(() => result.current.clearSelection())
    expect([...result.current.selectedIds]).toEqual([])
  })

  it('nudge returns false for a non-arrow key and when the selection is empty', () => {
    const { result, onCommitNudge } = setup({ a: { x: 0, y: 0, w: 360, h: 140 } })
    let consumed = true
    act(() => {
      consumed = result.current.nudge('x')
    })
    expect(consumed).toBe(false)
    act(() => {
      consumed = result.current.nudge('ArrowRight')
    })
    expect(consumed).toBe(false) // empty selection → not consumed
    expect(onCommitNudge).not.toHaveBeenCalled()
  })

  it('nudge commits a delta-applied move for the selection and returns true', () => {
    const { result, onCommitNudge } = setup({ a: { x: 10, y: 20, w: 360, h: 140 } })
    act(() => result.current.setSelection(['a']))
    let consumed = false
    act(() => {
      consumed = result.current.nudge('ArrowRight')
    })
    expect(consumed).toBe(true)
    expect(onCommitNudge).toHaveBeenCalledWith([
      { noteId: 'a', from: { x: 10, y: 20 }, to: { x: 18, y: 20 } },
    ])
  })

  it('cancelDrag returns false when nothing is in progress', () => {
    const { result } = setup()
    let consumed = true
    act(() => {
      consumed = result.current.cancelDrag()
    })
    expect(consumed).toBe(false)
  })
})

describe('useCanvasInteractions — edge-draw gesture START (Task 6)', () => {
  // Only the SYNCHRONOUS gesture start + the modifier remap run headless here;
  // the pointer move→drop choreography (native listeners + setPointerCapture) is
  // smoke-tested in Task 10 (spec §8 / §3).
  it('ctrl-drag on a card starts an edge, does not select', () => {
    const { result } = setup(EDGE_BOARD, { viewport: fakeViewport() })
    act(() => result.current.onCardPointerDown(evt({ ctrlKey: true }), 'A'))
    expect(result.current.selectedIds.size).toBe(0)
    expect(result.current.edgeDragState?.fromNoteId).toBe('A')
  })

  it('ctrl+alt-drag starts a LABELED edge', () => {
    const { result } = setup(EDGE_BOARD, { viewport: fakeViewport() })
    act(() => result.current.onCardPointerDown(evt({ ctrlKey: true, altKey: true }), 'A'))
    expect(result.current.edgeDragState?.labeled).toBe(true)
  })

  it('shift adds to selection; ctrl does NOT (ctrl is the edge modifier now)', () => {
    const { result } = setup(EDGE_BOARD, { viewport: fakeViewport() })
    act(() => result.current.onCardPointerDown(evt({}), 'A')) // plain → select A
    act(() => result.current.onCardPointerDown(evt({ shiftKey: true }), 'B')) // additive → A+B
    expect(result.current.selectedIds.size).toBe(2)
    act(() => result.current.onCardPointerDown(evt({ ctrlKey: true }), 'C')) // ctrl → edge, NOT add
    expect(result.current.selectedIds.has('C')).toBe(false)
  })

  it('the connect handle starts an edge unconditionally (no modifier needed)', () => {
    const { result } = setup(EDGE_BOARD, { viewport: fakeViewport() })
    act(() => result.current.onConnectHandleDown(evt({}), 'A'))
    expect(result.current.selectedIds.size).toBe(0)
    expect(result.current.edgeDragState?.fromNoteId).toBe('A')
    expect(result.current.edgeDragState?.labeled).toBe(false)
  })

  it('cancelEdgeDrag clears an in-progress edge drag', () => {
    const { result } = setup(EDGE_BOARD, { viewport: fakeViewport() })
    act(() => result.current.onCardPointerDown(evt({ ctrlKey: true }), 'A'))
    act(() => {
      expect(result.current.cancelEdgeDrag()).toBe(true)
    })
    expect(result.current.edgeDragState).toBeNull()
  })

  it('cancelEdgeDrag returns false when no edge drag is active', () => {
    const { result } = setup(EDGE_BOARD, { viewport: fakeViewport() })
    let consumed = true
    act(() => {
      consumed = result.current.cancelEdgeDrag()
    })
    expect(consumed).toBe(false)
  })
})
