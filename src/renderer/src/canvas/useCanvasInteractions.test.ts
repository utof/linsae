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

function setup(placed: Record<string, WorldRect> = {}) {
  const cameraRef: RefObject<Camera> = createRef() as RefObject<Camera>
  cameraRef.current = { x: 0, y: 0, zoom: 1 }
  const viewportRef = createRef<HTMLDivElement | null>()
  const placedRects = new Map(Object.entries(placed))
  const index = new CardSpatialIndex()
  for (const [id, rect] of placedRects) index.setCard(id, rect)
  const onCommitMove = vi.fn()
  const onCommitNudge = vi.fn<(m: { noteId: string; from: Point; to: Point }[]) => void>()
  const { result } = renderHook(() =>
    useCanvasInteractions({
      cameraRef,
      viewportRef,
      placedRects,
      index,
      onCommitMove,
      onCommitNudge,
    }),
  )
  return { result, onCommitMove, onCommitNudge }
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
