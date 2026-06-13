/**
 * The canvas stage shell: a focusable, overflow-hidden viewport containing a
 * single transformed world container. Cards render inside the world as
 * absolutely-positioned NoteCard elements (Task 6).
 *
 * Culling: only cards that intersect the inflated viewport rect (one viewport-
 * size margin on each side, spec §3) are rendered; the spatial index is rebuilt
 * on every layout-data change and updated incrementally on each card's measured
 * height change. Visible ids are memoised on [camera, layouts, cullEpoch].
 *
 * Keep-alive: the 32 most recently exited cards stay mounted with
 * `display: none` so their Markdown parse trees survive a brief pan-out and
 * pan-back. react-markdown re-parses on every mount; element caches cannot
 * survive unmount — keep-alive is the lever.
 *
 * Why a separate transformed container (vs transforming the viewport): the
 * viewport stays a fixed, clip-bounding box (`overflow: hidden`) while the world
 * pans/zooms underneath it; future overlays (edges, selection box) can sit in
 * the viewport's untransformed space alongside the world.
 *
 * No `content-visibility` anywhere on this surface (spec product decision 6).
 *
 * @see docs/specs/v0.4-canvas-mvp.md §3 (stage transform, culling, keep-alive)
 * @see src/renderer/src/canvas/useCanvasCamera.ts
 */
import { useQuery } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { MANUAL_ARRANGEMENT_ID, ROOT_CANVAS_ID } from '../../../shared/canvas'
import { api } from '../lib/api'
import { visibleWorldRect } from './camera'
import { NoteCard } from './NoteCard'
import { CardSpatialIndex } from './spatial-index'
import { useCanvasCamera } from './useCanvasCamera'

interface Props {
  /** Navigate to (or draft) the note for a clicked `[[slug]]` wikilink. */
  onWikilinkClick: (slug: string) => void
  /** Synchronous dangling-class check for a wikilink slug (render pass). */
  resolveSlug: (slug: string) => boolean
}

/**
 * Why 32: ~2 viewports' worth of cards at 1:1 zoom (spec §3 keep-alive budget).
 * Covers a pan-back without letting the hidden DOM grow without bound.
 */
const KEEP_ALIVE_SIZE = 32

/**
 * Default card height in world px before the first ResizeObserver measurement
 * (spec §11: 140 px placeholder height for spatial index seeding).
 */
const DEFAULT_CARD_HEIGHT = 140

/**
 * Renders the canvas viewport for the root canvas. The viewport div always
 * mounts (gestures bind immediately, layout is stable), but the world
 * container is gated on the camera hook's `ready` flag — its first paint is
 * at the persisted camera, never {0,0,1}-then-jump.
 *
 * Cards are sorted by `placed_at` ascending (DOM order = stacking; no z-index
 * per card) so later-placed cards appear on top.
 */
export function CanvasStage({ onWikilinkClick, resolveSlug }: Props): React.JSX.Element {
  const viewportRef = useRef<HTMLDivElement>(null)
  const { camera, ready, isMoving } = useCanvasCamera(ROOT_CANVAS_ID, viewportRef, {
    unclampZoom: false,
  })

  // ---- Viewport size tracking (for culling rect)
  const [viewportSize, setViewportSize] = useState({ w: 0, h: 0 })
  useEffect(() => {
    const el = viewportRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect
      if (r) setViewportSize({ w: r.width, h: r.height })
    })
    ro.observe(el)
    // Seed from getBoundingClientRect in case ResizeObserver fires late
    const rect = el.getBoundingClientRect()
    if (rect.width > 0 || rect.height > 0) setViewportSize({ w: rect.width, h: rect.height })
    return () => ro.disconnect()
  }, [])

  // ---- Layout data: placed cards for the root canvas / manual arrangement
  const { data: layouts = [] } = useQuery({
    queryKey: ['canvas-layouts', ROOT_CANVAS_ID],
    queryFn: () =>
      api.canvas.listLayouts({ canvasId: ROOT_CANVAS_ID, arrangementId: MANUAL_ARRANGEMENT_ID }),
  })

  // ---- Spatial index + height cache
  const indexRef = useRef(new CardSpatialIndex())
  const heightCacheRef = useRef(new Map<string, number>())

  // Rebuild the spatial index whenever layout data changes
  const placedLayouts = useMemo(
    () => layouts.filter((r) => r.x !== null && r.y !== null),
    [layouts],
  )
  useEffect(() => {
    indexRef.current.rebuild(
      placedLayouts.map((r) => ({
        id: r.note_id,
        rect: {
          x: r.x as number,
          y: r.y as number,
          w: 360,
          h: heightCacheRef.current.get(r.note_id) ?? DEFAULT_CARD_HEIGHT,
        },
      })),
    )
  }, [placedLayouts])

  // Bump this epoch whenever a card's measured height changes so the visible
  // set recomputes (memo dep below).
  const [cullEpoch, setCullEpoch] = useState(0)

  const handleMeasured = useCallback((noteId: string, h: number) => {
    const prev = heightCacheRef.current.get(noteId)
    if (prev === h) return
    heightCacheRef.current.set(noteId, h)
    indexRef.current.setCard(noteId, {
      x: 0, // overwritten by rebuild; setCard merges with existing position
      y: 0,
      w: 360,
      h,
    })
    // Re-read position from placed layouts to update correctly
    setCullEpoch((e) => e + 1)
  }, [])

  // Re-update card in index with correct position when height changes.
  // cullEpoch is an intentional extra dep: it gates re-runs when the index is
  // mutated via handleMeasured (indexRef.current is a stable ref, invisible to biome).
  // biome-ignore lint/correctness/useExhaustiveDependencies: cullEpoch intentionally triggers rerun when spatial index is mutated via handleMeasured
  useEffect(() => {
    for (const r of placedLayouts) {
      const h = heightCacheRef.current.get(r.note_id)
      if (h !== undefined) {
        indexRef.current.setCard(r.note_id, {
          x: r.x as number,
          y: r.y as number,
          w: 360,
          h,
        })
      }
    }
  }, [cullEpoch, placedLayouts])

  // ---- Visible ids: spatial search memoised on camera + layouts + cullEpoch.
  // placedLayouts and cullEpoch are intentional extra deps: they gate re-runs when
  // the spatial index is rebuilt/mutated (indexRef.current is a stable ref, invisible to biome).
  // biome-ignore lint/correctness/useExhaustiveDependencies: placedLayouts + cullEpoch intentionally gate spatial index re-reads
  const visibleIds = useMemo(() => {
    const { w, h } = viewportSize
    const rect = visibleWorldRect(camera, w, h, 1)
    return new Set(indexRef.current.search(rect))
  }, [camera, placedLayouts, cullEpoch, viewportSize])

  // ---- Keep-alive: LRU queue of up to KEEP_ALIVE_SIZE recently exited cards
  const keepAliveQueueRef = useRef<string[]>([])
  const keepAliveIds = useMemo(() => {
    // Add cards that just exited the visible set to the front of the queue
    const queue = keepAliveQueueRef.current
    const allPlacedIds = placedLayouts.map((r) => r.note_id)

    // Remove cards from queue that are now visible or no longer placed
    const filtered = queue.filter((id) => !visibleIds.has(id) && allPlacedIds.includes(id))

    // For every placed card not visible and not already in queue, prepend it
    // (we don't know which just "exited" vs never was visible — we keep recently
    // rendered ones; the queue is already ordered from most to least recent)
    keepAliveQueueRef.current = filtered.slice(0, KEEP_ALIVE_SIZE)
    return new Set(keepAliveQueueRef.current)
  }, [visibleIds, placedLayouts])

  // After render, update the keep-alive queue to track what was just visible
  // so next cull correctly identifies "just exited" cards.
  const prevVisibleRef = useRef(new Set<string>())
  useEffect(() => {
    const queue = keepAliveQueueRef.current
    // Cards that were visible last render but are not visible now → add to queue
    for (const id of prevVisibleRef.current) {
      if (!visibleIds.has(id) && !queue.includes(id)) {
        queue.unshift(id)
      }
    }
    // Trim to budget
    keepAliveQueueRef.current = queue.slice(0, KEEP_ALIVE_SIZE)
    prevVisibleRef.current = visibleIds
  })

  // ---- Cards to render: visible ∪ keep-alive, sorted by placed_at ascending
  const cardsToRender = useMemo(() => {
    return placedLayouts
      .filter((r) => visibleIds.has(r.note_id) || keepAliveIds.has(r.note_id))
      .sort((a, b) => (a.placed_at ?? 0) - (b.placed_at ?? 0))
  }, [placedLayouts, visibleIds, keepAliveIds])

  return (
    // tabIndex makes the viewport focusable so canvas-scoped hotkeys can check
    // focus (Task 6+). The world transform composes a translate (negated, in
    // screen px) with a scale — origin 0,0 so world coords map linearly.
    <div
      ref={viewportRef}
      // tabIndex makes the pannable canvas surface focusable so canvas-scoped
      // hotkeys can gate on focus (Task 6+); the plan mandates a focusable
      // viewport div. role="application" marks it as an interactive widget
      // region (the canvas owns its own keyboard interaction model).
      role="application"
      aria-label="canvas"
      // biome-ignore lint/a11y/noNoninteractiveTabindex: canvas is a focusable spatial widget (role=application) owning its own keyboard model; plan mandates a focusable viewport so canvas-scoped hotkeys can gate on focus
      tabIndex={0}
      data-canvas-viewport
      style={{
        flex: 1,
        overflow: 'hidden',
        position: 'relative',
        background: 'var(--bg-0)',
        outline: 'none',
      }}
    >
      {ready && (
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            transformOrigin: '0 0',
            transform:
              `translate(${-camera.x * camera.zoom}px, ${-camera.y * camera.zoom}px)` +
              ` scale(${camera.zoom})`,
          }}
          data-canvas-world
        >
          {cardsToRender.map((r) => (
            <NoteCard
              key={r.note_id}
              noteId={r.note_id}
              x={r.x as number}
              y={r.y as number}
              keptAlive={keepAliveIds.has(r.note_id) && !visibleIds.has(r.note_id)}
              isMoving={isMoving}
              onMeasured={handleMeasured}
              onWikilinkClick={onWikilinkClick}
              resolveSlug={resolveSlug}
              onBeginEdit={() => {}}
            />
          ))}
        </div>
      )}
    </div>
  )
}
