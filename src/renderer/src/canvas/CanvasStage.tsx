/**
 * The canvas stage shell: a focusable, overflow-hidden viewport containing a
 * single transformed world container. Cards render inside the world as
 * absolutely-positioned NoteCard elements (Task 6).
 *
 * Culling: only cards that intersect the inflated viewport rect (one viewport-
 * size margin on each side, spec §3) are rendered. The rbush spatial index is
 * built DURING render in a `useMemo` from the placed layouts' real x/y and the
 * measured-height cache, so `visibleIds` reads a fresh index in the same render
 * (no post-render rebuild effect → no render→effect→setState cull loop). The
 * index memo re-runs on `[placedLayouts, cullEpoch]`; `handleMeasured` bumps
 * `cullEpoch` only when a card's height genuinely changes.
 *
 * Keep-alive: the 32 most recently exited cards stay mounted with
 * `display: none` so their Markdown parse trees survive a brief pan-out and
 * pan-back. react-markdown re-parses on every mount; element caches cannot
 * survive unmount — keep-alive is the lever. Exit-tracking runs DURING render
 * (reading the previous render's visible set from a ref) so a card stays mounted
 * on the very render it exits; the computation is idempotent under StrictMode
 * double-invocation (running the memo body twice yields the same queue).
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

/** Fixed card width in world px at 1:1 (spec §3). */
const CARD_WIDTH = 360

/**
 * Stable empty array for the layouts query default. A fresh `[]` literal each
 * render (the `= []` default while `data` is undefined) would give `useMemo`'s
 * `[layouts]` dep a new reference every render, defeating memoisation during the
 * query's loading phase. Why a module constant: identity is stable across renders.
 */
const EMPTY: never[] = []

/**
 * Renders the canvas viewport for the root canvas. The viewport div always
 * mounts (gestures bind immediately, layout is stable), but the world
 * container is gated on the camera hook's `ready` flag — its first paint is
 * at the persisted camera, never {0,0,1}-then-jump.
 *
 * Cards are sorted by `placed_at` ascending (DOM order = stacking; no z-index
 * per card) so later-placed cards appear on top.
 *
 * @see docs/specs/v0.4-canvas-mvp.md §3
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
  const { data: layouts = EMPTY } = useQuery({
    queryKey: ['canvas-layouts', ROOT_CANVAS_ID],
    queryFn: () =>
      api.canvas.listLayouts({ canvasId: ROOT_CANVAS_ID, arrangementId: MANUAL_ARRANGEMENT_ID }),
  })

  // Placed-only rows (a NULL x/y row is on the shelf — spec §1, never a card).
  const placedLayouts = useMemo(
    () => layouts.filter((r) => r.x !== null && r.y !== null),
    [layouts],
  )

  // ---- Measured-height cache, keyed by note id; mutated by handleMeasured.
  const heightCacheRef = useRef(new Map<string, number>())

  // Bumped by handleMeasured when a card's measured height genuinely changes, so
  // the index memo (which reads the height cache, invisible to biome) re-runs.
  const [cullEpoch, setCullEpoch] = useState(0)

  /**
   * Spatial index built DURING render from the placed layouts' real x/y and the
   * measured-height cache. Building it in render (not a post-render effect) means
   * `visibleIds` reads a fresh index in the SAME render — no staleness, and no
   * render→effect→setState cull loop. Bug 1 (measure-time origin teleport) is
   * unrepresentable here: the index is always seeded from each row's real x/y.
   * Why `cullEpoch` is a dep: the height cache is a ref (biome can't see it), so
   * `cullEpoch` gates rebuilds when a measured height changes.
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: cullEpoch gates height-cache reads (heightCacheRef is a stable ref)
  const index = useMemo(() => {
    const idx = new CardSpatialIndex()
    idx.rebuild(
      placedLayouts.map((r) => ({
        id: r.note_id,
        rect: {
          x: r.x as number,
          y: r.y as number,
          w: CARD_WIDTH,
          h: heightCacheRef.current.get(r.note_id) ?? DEFAULT_CARD_HEIGHT,
        },
      })),
    )
    return idx
  }, [placedLayouts, cullEpoch])

  /**
   * Record a card's measured shell height and trigger one index rebuild iff the
   * height actually changed. The `prev === h` guard is load-bearing: it stops a
   * measure→rebuild→remeasure loop (a re-render with unchanged content fires no
   * new ResizeObserver, and a no-op measure short-circuits here). No `setCard` —
   * the next render's index memo picks the new height up from the cache.
   */
  const handleMeasured = useCallback((noteId: string, h: number) => {
    if (heightCacheRef.current.get(noteId) === h) return
    heightCacheRef.current.set(noteId, h)
    setCullEpoch((e) => e + 1)
  }, [])

  // ---- Visible ids: cards intersecting the inflated viewport rect. Reads the
  // freshly-built in-render index, so it reflects this render's layout + heights.
  const visibleIds = useMemo(() => {
    const { w, h } = viewportSize
    return new Set(index.search(visibleWorldRect(camera, w, h, 1)))
  }, [index, camera, viewportSize])

  // ---- Keep-alive: LRU queue of up to KEEP_ALIVE_SIZE recently-exited cards.
  //
  // Exit-tracking runs DURING render so a card stays mounted on the render it
  // exits (a post-render effect would unmount it for one render first). The
  // computation is pure and idempotent under StrictMode double-invocation:
  // pass 2 reads `prevVisibleRef` already set to `visibleIds` by pass 1, finds
  // no exits, and re-filtering the already-filtered queue is a fixed point — so
  // both passes commit the same queue and return the same Set.
  const keepAliveQueueRef = useRef<string[]>([])
  const prevVisibleRef = useRef(new Set<string>())
  const keepAliveIds = useMemo(() => {
    const placedIds = new Set(placedLayouts.map((r) => r.note_id))
    // Newly exited: visible in the previous render, not visible now.
    const exited = [...prevVisibleRef.current].filter((id) => !visibleIds.has(id))
    // Most-recent-first, dedup, drop now-visible / unplaced, cap at budget.
    const next: string[] = []
    const seen = new Set<string>()
    for (const id of [...exited, ...keepAliveQueueRef.current]) {
      const keep = !seen.has(id) && !visibleIds.has(id) && placedIds.has(id)
      seen.add(id)
      if (keep) next.push(id)
    }
    keepAliveQueueRef.current = next.slice(0, KEEP_ALIVE_SIZE)
    prevVisibleRef.current = visibleIds
    return new Set(keepAliveQueueRef.current)
  }, [visibleIds, placedLayouts])

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
