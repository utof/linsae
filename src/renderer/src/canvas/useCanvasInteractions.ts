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

/**
 * Live edge-draw state (spec §3): a rubber-band from a source card to the cursor
 * while drawing a link. Exposed as state so CanvasStage's underlay rubber-band
 * layer follows it; `null` when no edge drag is in progress (so the underlay can
 * idle — #112). `labeled` flags `ctrl+alt` (typed-edge) mode.
 */
export interface EdgeDragState {
  fromNoteId: string
  /** Source card center in world coords (the rubber-band tail). */
  startWorld: Point
  /** Cursor (or snapped target-card center) in world coords (the head). */
  currentWorld: Point
  /** The card the cursor is over (snap target), else null. Never the source. */
  targetCardId: string | null
  /** True for `ctrl+alt` / labeled-mode: drop opens a free-text type field (decision 2). */
  labeled: boolean
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
  /** pointerdown on a card → begins a (possibly group) move drag, OR a ctrl-edge-draw. */
  onCardPointerDown: (e: React.PointerEvent, noteId: string) => void
  /** pointerdown on empty surface → begins a marquee. */
  onSurfacePointerDown: (e: React.PointerEvent) => void
  /** pointerdown on a card's hover connect-handle → ALWAYS begins an edge-draw (spec §3). */
  onConnectHandleDown: (e: React.PointerEvent, noteId: string) => void
  /** Live edge-draw rubber-band state, else null (spec §3). */
  edgeDragState: EdgeDragState | null
  /** Cancel an in-progress edge-draw (esc): release without connecting. Returns true if it consumed. */
  cancelEdgeDrag: () => boolean
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

/**
 * Drag-slop in SCREEN px: a marquee pointer must travel at least this far from
 * its down point before it counts as a rubber-band. Below it the gesture is a
 * bare click (empty surface → clear selection). Screen-space (not world) so the
 * threshold is zoom-independent — jitter is a physical pointer phenomenon.
 * Why: a few px of pointer jitter between down and up otherwise opens a tiny
 * marquee that REPLACES (shrinks) the selection instead of clearing it (#132).
 * @issue utof/linsae#132
 */
const DRAG_SLOP_PX = 4

/** Live bookkeeping for a marquee rubber-band; held in a ref. */
interface MarqueeSession {
  pointerId: number
  /** World point where the band began. */
  startWorld: Point
  /** Screen point (viewport-relative client) where the band began — slop origin (#132). */
  startScreen: Point
  /** Selection BEFORE the marquee (for additive ⇧/⌘ union). */
  base: ReadonlySet<string>
  /** True when ⇧/⌘ was held at marquee start (union, not replace). */
  additive: boolean
  /** Set once the pointer passes DRAG_SLOP_PX: a rubber-band, not a bare/jittery click. */
  moved: boolean
}

/** Live bookkeeping for an edge-draw gesture; held in a ref so listeners don't re-bind. */
interface EdgeDragSession {
  pointerId: number
  fromNoteId: string
  /** True for ctrl+alt / connect-handle-with-alt: drop opens the type field. */
  labeled: boolean
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

/** Center of a placed card rect (the edge endpoint anchor); origin if absent. */
function center(rect: WorldRect | undefined): Point {
  if (!rect) return { x: 0, y: 0 }
  return { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 }
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
 * @param args.onCreateEdge drop-on-card commit: write a link source→target (spec §3)
 * @param args.onEdgeTargetPicker drop-in-empty: open the target picker at the drop point (spec §4)
 * @param args.hitVisibleAt topmost VISIBLE card id at a world point (edge snap + drop target)
 */
export function useCanvasInteractions(args: {
  cameraRef: RefObject<Camera>
  viewportRef: RefObject<HTMLDivElement | null>
  placedRects: Map<string, WorldRect>
  index: CardSpatialIndex
  onCommitMove: (moves: { noteId: string; from: Point; to: Point }[]) => void
  onCommitNudge: (moves: { noteId: string; from: Point; to: Point }[]) => void
  onCreateEdge: (fromNoteId: string, toNoteId: string, labeled: boolean) => void
  onEdgeTargetPicker: (dropWorld: Point, fromNoteId: string, labeled: boolean) => void
  hitVisibleAt: (world: Point) => string | null
}): CanvasInteractions {
  const {
    cameraRef,
    viewportRef,
    index,
    onCommitMove,
    onCommitNudge,
    onCreateEdge,
    onEdgeTargetPicker,
    hitVisibleAt,
  } = args

  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(() => new Set())
  const [marquee, setMarquee] = useState<WorldBox | null>(null)
  const [dragOffset, setDragOffset] = useState<{ dx: number; dy: number } | null>(null)
  const [edgeDragState, setEdgeDragState] = useState<EdgeDragState | null>(null)

  // Live mirrors read inside the viewport pointer listeners (no re-bind needed).
  const selectedRef = useRef(selectedIds)
  selectedRef.current = selectedIds
  const placedRef = useRef(args.placedRects)
  placedRef.current = args.placedRects
  // Edge callbacks/hit-test mirrored so the once-bound pointer listeners read the
  // latest closures without re-binding (same posture as selectedRef/placedRef).
  const onCreateEdgeRef = useRef(onCreateEdge)
  onCreateEdgeRef.current = onCreateEdge
  const onEdgeTargetPickerRef = useRef(onEdgeTargetPicker)
  onEdgeTargetPickerRef.current = onEdgeTargetPicker
  const hitVisibleAtRef = useRef(hitVisibleAt)
  hitVisibleAtRef.current = hitVisibleAt

  const dragRef = useRef<DragSession | null>(null)
  const marqueeRef = useRef<MarqueeSession | null>(null)
  const edgeDragRef = useRef<EdgeDragSession | null>(null)

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

  /**
   * Begin an edge-draw from `noteId` (spec §3). Sets the ref session + an INITIAL
   * zero-length rubber-band state (so START is unit-testable + the band exists
   * from frame 0), captures the pointer. Shared by the ctrl-drag path and the
   * always-on connect handle.
   */
  const startEdgeDrag = useCallback(
    (e: React.PointerEvent, noteId: string, labeled: boolean) => {
      const viewport = viewportRef.current
      if (!viewport) return
      e.preventDefault()
      e.stopPropagation()
      edgeDragRef.current = { pointerId: e.pointerId, fromNoteId: noteId, labeled }
      const c = center(placedRef.current.get(noteId))
      setEdgeDragState({
        fromNoteId: noteId,
        startWorld: c,
        currentWorld: c,
        targetCardId: null,
        labeled,
      })
      viewport.setPointerCapture(e.pointerId)
    },
    [viewportRef],
  )

  const onCardPointerDown = useCallback(
    (e: React.PointerEvent, noteId: string) => {
      const viewport = viewportRef.current
      if (e.button !== 0 || !viewport) return
      // ctrl-drag from a card body starts an edge (ctrl+alt = labeled) — the power
      // path; the connect handle is the discoverable one (spec §3 decision 2).
      if (e.ctrlKey) {
        startEdgeDrag(e, noteId, e.altKey)
        return
      }
      e.preventDefault()
      e.stopPropagation()
      // Modifier-click toggles; a plain click on a card outside the selection
      // collapses the selection to just it before the drag (spec §8). Additive is
      // shift||meta now — ctrl is the edge modifier (decision 2).
      const additive = e.shiftKey || e.metaKey
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
    [viewportRef, setSelection, toggleSelection, startEdgeDrag],
  )

  /**
   * pointerdown on a card's hover connect-handle → ALWAYS an edge-draw, regardless
   * of modifier (the discoverable affordance; `alt` flags labeled). The handle's
   * own `stopPropagation` keeps this from also reaching the move/marquee router.
   */
  const onConnectHandleDown = useCallback(
    (e: React.PointerEvent, noteId: string) => {
      if (e.button !== 0) return
      startEdgeDrag(e, noteId, e.altKey)
    },
    [startEdgeDrag],
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
        startScreen: { x: e.clientX, y: e.clientY },
        base: selectedRef.current,
        // Additive is shift||meta now — ctrl is reserved for edges (decision 2).
        additive: e.shiftKey || e.metaKey,
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
      // Edge-draw FIRST: it must not fall through to the move/marquee branches.
      const edge = edgeDragRef.current
      if (edge && edge.pointerId === e.pointerId) {
        const currentWorld = clientToWorld(camera, viewport, e.clientX, e.clientY)
        const hit = hitVisibleAtRef.current(currentWorld)
        // The source card is never a snap target (no self-edges, spec §1/§2).
        const targetCardId = hit && hit !== edge.fromNoteId ? hit : null
        setEdgeDragState({
          fromNoteId: edge.fromNoteId,
          startWorld: center(placedRef.current.get(edge.fromNoteId)),
          currentWorld,
          targetCardId,
          labeled: edge.labeled,
        })
        return
      }
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
        // Drag-slop gate (#132): ignore sub-threshold jitter so the gesture stays
        // a click (empty-surface clear) instead of a tiny replace-marquee. Once
        // past slop it latches `moved` and the live rubber-band hit-test runs.
        if (
          !mq.moved &&
          Math.hypot(e.clientX - mq.startScreen.x, e.clientY - mq.startScreen.y) < DRAG_SLOP_PX
        )
          return
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
      // Edge-draw FIRST: resolve drop → create-on-card or open the empty-drop picker.
      const edge = edgeDragRef.current
      if (edge && edge.pointerId === e.pointerId) {
        edgeDragRef.current = null
        if (viewport.hasPointerCapture(e.pointerId)) viewport.releasePointerCapture(e.pointerId)
        setEdgeDragState(null)
        const camera = cameraRef.current
        if (!camera) return
        const dropWorld = clientToWorld(camera, viewport, e.clientX, e.clientY)
        const target = hitVisibleAtRef.current(dropWorld)
        if (target && target !== edge.fromNoteId) {
          onCreateEdgeRef.current(edge.fromNoteId, target, edge.labeled)
        } else {
          // Drop on the source itself or in empty space → target picker at the drop.
          onEdgeTargetPickerRef.current(dropWorld, edge.fromNoteId, edge.labeled)
        }
        return
      }
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

  // ---- cancelEdgeDrag (esc): abort an in-flight edge-draw with no connect (spec
  // §3 cascade). Returns false when no edge drag is active so the cascade falls
  // through to the next consumer.
  const cancelEdgeDrag = useCallback((): boolean => {
    const edge = edgeDragRef.current
    if (!edge) return false
    const viewport = viewportRef.current
    if (viewport?.hasPointerCapture(edge.pointerId)) viewport.releasePointerCapture(edge.pointerId)
    edgeDragRef.current = null
    setEdgeDragState(null)
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
    onConnectHandleDown,
    edgeDragState,
    cancelEdgeDrag,
    nudge,
    cancelDrag,
  }
}
