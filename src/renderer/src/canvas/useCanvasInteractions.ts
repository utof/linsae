/**
 * Pointer state machine for canvas arranging (spec §8): selection, card drag,
 * group drag, marquee rubber-band, and arrow-key nudge. The hook OWNS selection
 * + the in-flight drag/marquee state; it does NOT own the camera or the layouts
 * query — those are passed in (`cameraRef`, `placedRects`, `index`). Commits
 * flow OUT via `onCommitMove`/`onCommitNudge` callbacks so CanvasStage composes
 * them into the spatial-undo stack + IPC writes.
 *
 * Why a hook (not a component): the drag/marquee gestures attach pointer
 * listeners to the same viewport node as `useCanvasCamera`, and the live offset
 * / marquee rect must feed the stage transform — a hook keeps that wiring out of
 * JSX while exposing the live values as state. All geometry delegates to the
 * pure `selection-geometry` helpers (Task 1, already tested headless).
 *
 * Why refs for live values: a drag may run while the camera pans (space-drag is
 * a separate gesture, but zoom-via-wheel keeps working) — reading the camera and
 * the in-flight drag bookkeeping via refs means the viewport pointer listeners
 * never re-bind mid-gesture (same posture as `useCanvasCamera`, ADR 0006).
 *
 * The pixel-level pointer path (drag/marquee) is verified by the Plan-4
 * Playwright harness; happy-dom has no pointer/layout model, so this file ships
 * without a colocated pointer test — its logic is the Task-1 pure helpers plus
 * thin glue, and the NoteCard ring test covers the only headless-visible
 * contract this task asserts.
 *
 * @see docs/specs/v0.4-canvas-mvp.md §8 (drag, marquee, group, nudge, axis-lock)
 * @see docs/specs/v0.4-canvas-mvp.md §13 (undo composed by the caller)
 * @see src/renderer/src/canvas/useCanvasCamera.ts (ref + non-passive posture)
 */
import { type RefObject, useCallback, useEffect, useRef, useState } from 'react'
import type { Camera, Point } from './camera'
import { screenToWorld } from './camera'
import { marqueeRect, nudgeDelta } from './selection-geometry'
import type { CardSpatialIndex, WorldRect } from './spatial-index'

/** Normalized world-space rect (marquee / index query shape). */
interface WorldBox {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

export interface CanvasInteractions {
  selectedIds: ReadonlySet<string>
  /** Replace selection (marquee commit / single click). */
  setSelection: (ids: Iterable<string>) => void
  /** Toggle one id (⇧/⌘-click). */
  toggleSelection: (id: string) => void
  clearSelection: () => void
  /** Live marquee rect in WORLD coords while rubber-banding, else null. */
  marquee: WorldBox | null
  /** Live drag offset (world dx,dy) applied to selected cards, else null. */
  dragOffset: { dx: number; dy: number } | null
  /** True while a card/group drag or marquee is in progress (esc-cascade + drag guard). */
  dragging: boolean
  /** pointerdown on a card → begins a (possibly group) move drag. */
  onCardPointerDown: (e: React.PointerEvent, noteId: string) => void
  /** pointerdown on empty surface → begins a marquee. */
  onSurfacePointerDown: (e: React.PointerEvent) => void
  /** Nudge the selection by an arrow key (8 px); returns true if it consumed the key. */
  nudge: (key: string) => boolean
  /** Cancel an in-progress drag/marquee (esc): snap home, no write. Returns true if it consumed. */
  cancelDrag: () => boolean
}

/** Live bookkeeping for a card/group drag; held in a ref so listeners don't re-bind. */
interface DragSession {
  pointerId: number
  /** Screen point (viewport-relative) where the drag began. */
  startScreen: Point
  /** Ids being dragged (the selection at drag start). */
  ids: string[]
}

/** Live bookkeeping for a marquee rubber-band; held in a ref. */
interface MarqueeSession {
  pointerId: number
  /** World point where the band began. */
  startWorld: Point
  /** Selection BEFORE the marquee (for additive ⇧/⌘ union). */
  base: ReadonlySet<string>
  /** True when ⇧/⌘ was held at marquee start (union, not replace). */
  additive: boolean
  /** Set on the first pointer-move: distinguishes a rubber-band from a bare click. */
  moved: boolean
}

/** Convert a viewport-relative client point to world coords via the live camera. */
function clientToWorld(
  camera: Camera,
  viewport: HTMLElement,
  clientX: number,
  clientY: number,
): Point {
  const rect = viewport.getBoundingClientRect()
  return screenToWorld(camera, { x: clientX - rect.left, y: clientY - rect.top })
}

/**
 * Canvas arranging gestures bound to `viewportRef`'s node. `placedRects` and
 * `index` are read live (the caller rebuilds them as layouts change); commits
 * report each affected card's `from`(original rect top-left)→`to`(+delta).
 *
 * @param args.cameraRef live camera (world↔screen for drag deltas + marquee)
 * @param args.viewportRef the stage viewport node (pointer capture + listeners)
 * @param args.placedRects noteId→world rect, from CanvasStage (drag/nudge `from`)
 * @param args.index spatial index for marquee hit-testing (`index.search`)
 * @param args.onCommitMove pointerup commit of a drag (one undo entry)
 * @param args.onCommitNudge arrow-key commit (caller coalesces a burst via `at`)
 */
export function useCanvasInteractions(args: {
  cameraRef: RefObject<Camera>
  viewportRef: RefObject<HTMLDivElement | null>
  placedRects: Map<string, WorldRect>
  index: CardSpatialIndex
  onCommitMove: (moves: { noteId: string; from: Point; to: Point }[]) => void
  onCommitNudge: (moves: { noteId: string; from: Point; to: Point }[]) => void
}): CanvasInteractions {
  const { cameraRef, viewportRef, index, onCommitMove, onCommitNudge } = args

  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(() => new Set())
  const [marquee, setMarquee] = useState<WorldBox | null>(null)
  const [dragOffset, setDragOffset] = useState<{ dx: number; dy: number } | null>(null)

  // Live mirrors read inside the viewport pointer listeners (no re-bind needed).
  const selectedRef = useRef(selectedIds)
  selectedRef.current = selectedIds
  const placedRef = useRef(args.placedRects)
  placedRef.current = args.placedRects

  const dragRef = useRef<DragSession | null>(null)
  const marqueeRef = useRef<MarqueeSession | null>(null)

  // ---- Selection ops (stable callbacks; ADR 0006).
  const setSelection = useCallback((ids: Iterable<string>) => {
    setSelectedIds(new Set(ids))
  }, [])
  const toggleSelection = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])
  const clearSelection = useCallback(() => {
    setSelectedIds(new Set())
  }, [])

  // ---- pointerdown entry points (React handlers on stage elements). They set up
  // the drag/marquee session + capture the pointer on the viewport so move/up
  // listeners keep firing past the card edge.
  const onCardPointerDown = useCallback(
    (e: React.PointerEvent, noteId: string) => {
      const viewport = viewportRef.current
      if (e.button !== 0 || !viewport) return
      e.preventDefault()
      e.stopPropagation()
      // Modifier-click toggles; a plain click on a card outside the selection
      // collapses the selection to just it before the drag (spec §8).
      const additive = e.shiftKey || e.metaKey || e.ctrlKey
      let ids: string[]
      if (additive) {
        toggleSelection(noteId)
        ids = [...new Set([...selectedRef.current, noteId])]
      } else if (selectedRef.current.has(noteId)) {
        ids = [...selectedRef.current]
      } else {
        setSelection([noteId])
        ids = [noteId]
      }
      dragRef.current = {
        pointerId: e.pointerId,
        startScreen: { x: e.clientX, y: e.clientY },
        ids,
      }
      viewport.setPointerCapture(e.pointerId)
    },
    [viewportRef, setSelection, toggleSelection],
  )

  const onSurfacePointerDown = useCallback(
    (e: React.PointerEvent) => {
      const viewport = viewportRef.current
      const camera = cameraRef.current
      if (e.button !== 0 || !viewport || !camera) return
      const start = clientToWorld(camera, viewport, e.clientX, e.clientY)
      marqueeRef.current = {
        pointerId: e.pointerId,
        startWorld: start,
        base: selectedRef.current,
        additive: e.shiftKey || e.metaKey || e.ctrlKey,
        moved: false,
      }
      viewport.setPointerCapture(e.pointerId)
    },
    [viewportRef, cameraRef],
  )

  // ---- Viewport pointer listeners (non-passive, like useCanvasCamera). Bound
  // once; all live state is read via refs so a gesture mid-zoom stays correct.
  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return

    const onPointerMove = (e: PointerEvent) => {
      const camera = cameraRef.current
      if (!camera) return
      const drag = dragRef.current
      if (drag && drag.pointerId === e.pointerId) {
        // Screen movement → world delta (divide by live zoom).
        let dx = (e.clientX - drag.startScreen.x) / camera.zoom
        let dy = (e.clientY - drag.startScreen.y) / camera.zoom
        // ⇧ axis-lock: keep only the larger-magnitude axis (spec §8).
        if (e.shiftKey) {
          if (Math.abs(dx) >= Math.abs(dy)) dy = 0
          else dx = 0
        }
        setDragOffset({ dx, dy })
        return
      }
      const mq = marqueeRef.current
      if (mq && mq.pointerId === e.pointerId) {
        mq.moved = true
        const now = clientToWorld(camera, viewport, e.clientX, e.clientY)
        const box = marqueeRect(mq.startWorld, now)
        setMarquee(box)
        // Live hit-test; additive unions with the pre-marquee selection.
        const hit = index.search(box)
        const next = mq.additive ? new Set([...mq.base, ...hit]) : new Set(hit)
        setSelectedIds(next)
      }
    }

    const endGesture = (e: PointerEvent) => {
      const drag = dragRef.current
      if (drag && drag.pointerId === e.pointerId) {
        dragRef.current = null
        if (viewport.hasPointerCapture(e.pointerId)) viewport.releasePointerCapture(e.pointerId)
        const camera = cameraRef.current
        let dx = camera ? (e.clientX - drag.startScreen.x) / camera.zoom : 0
        let dy = camera ? (e.clientY - drag.startScreen.y) / camera.zoom : 0
        if (e.shiftKey) {
          if (Math.abs(dx) >= Math.abs(dy)) dy = 0
          else dx = 0
        }
        setDragOffset(null)
        // Only commit a real move (a click registers as a 0,0 drag — no-op).
        if (dx !== 0 || dy !== 0) {
          const moves: { noteId: string; from: Point; to: Point }[] = []
          for (const id of drag.ids) {
            const r = placedRef.current.get(id)
            if (!r) continue
            moves.push({ noteId: id, from: { x: r.x, y: r.y }, to: { x: r.x + dx, y: r.y + dy } })
          }
          if (moves.length > 0) onCommitMove(moves)
        }
        return
      }
      const mq = marqueeRef.current
      if (mq && mq.pointerId === e.pointerId) {
        marqueeRef.current = null
        if (viewport.hasPointerCapture(e.pointerId)) viewport.releasePointerCapture(e.pointerId)
        setMarquee(null)
        // A marquee with no movement = a bare empty-surface click → clear the
        // selection (unless ⇧/⌘ was held, which is additive). A real rubber-band
        // already committed its hit set live on pointer-move, so leave it.
        if (!mq.moved && !mq.additive) setSelectedIds(new Set())
      }
    }

    viewport.addEventListener('pointermove', onPointerMove)
    viewport.addEventListener('pointerup', endGesture)
    viewport.addEventListener('pointercancel', endGesture)
    return () => {
      viewport.removeEventListener('pointermove', onPointerMove)
      viewport.removeEventListener('pointerup', endGesture)
      viewport.removeEventListener('pointercancel', endGesture)
    }
  }, [viewportRef, cameraRef, index, onCommitMove])

  // ---- Nudge: arrow key → world delta on the whole selection (spec §8).
  const nudge = useCallback(
    (key: string): boolean => {
      const delta = nudgeDelta(key)
      if (!delta) return false
      const ids = selectedRef.current
      if (ids.size === 0) return false
      const moves: { noteId: string; from: Point; to: Point }[] = []
      for (const id of ids) {
        const r = placedRef.current.get(id)
        if (!r) continue
        moves.push({
          noteId: id,
          from: { x: r.x, y: r.y },
          to: { x: r.x + delta.dx, y: r.y + delta.dy },
        })
      }
      if (moves.length === 0) return false
      onCommitNudge(moves)
      return true
    },
    [onCommitNudge],
  )

  // ---- cancelDrag (esc): abort an in-flight drag/marquee with no commit.
  const cancelDrag = useCallback((): boolean => {
    const viewport = viewportRef.current
    const drag = dragRef.current
    const mq = marqueeRef.current
    if (!drag && !mq) return false
    if (viewport) {
      const id = drag?.pointerId ?? mq?.pointerId
      if (id !== undefined && viewport.hasPointerCapture(id)) viewport.releasePointerCapture(id)
    }
    dragRef.current = null
    marqueeRef.current = null
    setDragOffset(null)
    setMarquee(null)
    return true
  }, [viewportRef])

  return {
    selectedIds,
    setSelection,
    toggleSelection,
    clearSelection,
    marquee,
    dragOffset,
    dragging: dragOffset !== null || marquee !== null,
    onCardPointerDown,
    onSurfacePointerDown,
    nudge,
    cancelDrag,
  }
}
