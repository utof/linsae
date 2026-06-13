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
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { MANUAL_ARRANGEMENT_ID, ROOT_CANVAS_ID } from '../../../shared/canvas'
import type { Note, NoteType } from '../../../shared/types'
import { Composer } from '../composer/Composer'
import { api } from '../lib/api'
import type { UnderlayLayer } from './CanvasUnderlay'
import { CanvasUnderlay } from './CanvasUnderlay'
import { visibleWorldRect } from './camera'
import { useCanvasDevLod } from './dev-lod'
import { edgeSegment } from './edge-geometry'
import { tierForZoom } from './lod'
import { NoteCard } from './NoteCard'
import type { WorldRect } from './spatial-index'
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
 * (spec §11: 140 px placeholder height for spatial index seeding). The 1-viewport
 * cull inflation (§3) is what makes this low seed tolerable — a tall, never-
 * measured card straddling the cull boundary is the bounded edge case.
 * @issue utof/linsae#109
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
 * Number of synthetic dots generated for the dev-HUD "synthetic 10k dots" toggle
 * (spec §12 dot-tier perf probe). Big enough to stress the single-batch arc fill.
 */
const SYNTHETIC_DOT_COUNT = 10_000

/** World-space spread (px) the synthetic dots are scattered across. */
const SYNTHETIC_DOT_SPREAD = 100_000

/**
 * Module-level, generated once: 10k synthetic (x, y) world-coordinate pairs for
 * the dot-tier perf probe. A `Float32Array` (not an array of objects) so the
 * draw loop iterates a flat buffer with no per-dot allocation — the dot renderer
 * is the §16 perf canary. Generated lazily on first access so the random work is
 * paid only when the dev toggle is actually used.
 * @see docs/specs/v0.4-canvas-mvp.md §12
 */
let syntheticDotsCache: Float32Array | null = null
function getSyntheticDots(): Float32Array {
  if (syntheticDotsCache === null) {
    const buf = new Float32Array(SYNTHETIC_DOT_COUNT * 2)
    for (let i = 0; i < buf.length; i++) buf[i] = Math.random() * SYNTHETIC_DOT_SPREAD
    syntheticDotsCache = buf
  }
  return syntheticDotsCache
}

/** Screen-constant dot radius (px) at the dot tier, divided by zoom at draw time. */
const DOT_SCREEN_RADIUS = 3

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
  const queryClient = useQueryClient()

  // ---- DEV LOD overrides (ephemeral store; inert in prod — forceTier defaults
  // 'auto' and the [0.5,2.0] zoom clamp keeps tierForZoom in 'card' normally).
  const devLod = useCanvasDevLod()

  const { camera, ready, isMoving } = useCanvasCamera(ROOT_CANVAS_ID, viewportRef, {
    unclampZoom: devLod.unclampZoom,
  })

  // Active tier: a forced tier wins; otherwise zoom decides (spec §12). 'title'
  // and 'card' both render cards as today; only 'dot' swaps to the dot renderer.
  const tier = devLod.forceTier !== 'auto' ? devLod.forceTier : tierForZoom(camera.zoom)

  // ---- In-place card edit (spec §3): which card (by note id) is being edited.
  // Set by a NoteCard double-click; cleared on commit (mutation onSuccess) or
  // Composer esc. While set, that card hides (visibility:hidden, stays mounted so
  // its ResizeObserver measure persists) and a Composer renders over it.
  const [editingId, setEditingId] = useState<string | null>(null)

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

  // ---- Edge data: resolved links between placed notes (read-only, spec §11)
  const { data: edges = EMPTY } = useQuery({
    queryKey: ['canvas-edges', ROOT_CANVAS_ID],
    queryFn: () =>
      api.canvas.edges({ canvasId: ROOT_CANVAS_ID, arrangementId: MANUAL_ARRANGEMENT_ID }),
  })

  // ---- Measured-height cache, keyed by note id; mutated by handleMeasured.
  // Not pruned on unplace: bounded by note count, and a stale height only shifts
  // the cull rect within the 1-viewport inflation margin (§3), so it's tolerated.
  const heightCacheRef = useRef(new Map<string, number>())

  // Bumped by handleMeasured when a card's measured height genuinely changes, so
  // the index memo (which reads the height cache, invisible to biome) re-runs.
  const [cullEpoch, setCullEpoch] = useState(0)

  /**
   * Cached CSS token for edge stroke colour (`--fg-3`), resolved once on first
   * draw. A ref (not state) so it doesn't trigger a re-render when resolved.
   * Why lazy: `getComputedStyle` is a layout read; deferring it to the draw call
   * avoids any pre-paint cost and tolerates test envs where the value is empty.
   */
  const edgeColorRef = useRef<string | null>(null)

  /**
   * UnderlayLayer that draws resolved note edges in world coordinates. Rebuilt
   * on [edges, placedLayouts, cullEpoch] so a new array reference marks the
   * underlay dirty via the `layers` identity change (spec §3 dirty-flag cadence).
   * Reading placedLayouts + heightCacheRef here uses the SAME source as culling —
   * Plan 3 drag will only need to mark dirty per frame, no separate rect source.
   *
   * Why cullEpoch is a dep: heightCacheRef is a stable ref (biome can't see it),
   * so cullEpoch gates rebuilds when a measured height changes.
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: cullEpoch gates height-cache reads (heightCacheRef is a stable ref)
  const edgesLayer: UnderlayLayer = useMemo(() => {
    // Build a noteId → WorldRect map from the SAME height-cache/layout source
    // as the culling index, so both always agree on card rects.
    const rectByNoteId = new Map<string, WorldRect>()
    for (const r of placedLayouts) {
      rectByNoteId.set(r.note_id, {
        x: r.x as number,
        y: r.y as number,
        w: CARD_WIDTH,
        h: heightCacheRef.current.get(r.note_id) ?? DEFAULT_CARD_HEIGHT,
      })
    }

    return {
      // drawCamera (not the render-closure camera): the hairline math uses the
      // draw-time camera the underlay loop passes in, so zoom is current.
      draw(ctx: CanvasRenderingContext2D, drawCamera): void {
        if (edges.length === 0) return

        // Resolve the colour token lazily on first draw (getComputedStyle is a
        // layout read — defer to draw time so it's never called pre-paint).
        if (edgeColorRef.current === null) {
          edgeColorRef.current =
            getComputedStyle(document.documentElement).getPropertyValue('--fg-3').trim() ||
            'rgba(0,0,0,0.25)'
        }

        const color = edgeColorRef.current

        for (const edge of edges) {
          const fromRect = rectByNoteId.get(edge.fromNoteId)
          const toRect = rectByNoteId.get(edge.toNoteId)
          // Skip edges where either endpoint is unplaced or absent (spec §11).
          if (!fromRect || !toRect) continue

          const seg = edgeSegment(fromRect, toRect)
          // edgeSegment returns null for self-edges and overlapping cards.
          if (!seg) continue

          ctx.beginPath()
          ctx.strokeStyle = color
          ctx.lineWidth = 1 / drawCamera.zoom // screen-constant hairline
          ctx.globalAlpha = 0.25

          if (edge.edgeType === 'comment-on') {
            ctx.setLineDash([6 / drawCamera.zoom, 4 / drawCamera.zoom])
          } else {
            // 'reference' and any future types: solid line.
            ctx.setLineDash([])
          }

          ctx.moveTo(seg.x1, seg.y1)
          ctx.lineTo(seg.x2, seg.y2)
          ctx.stroke()

          // Reset per-edge state so strokes don't bleed into each other.
          ctx.globalAlpha = 1
          ctx.setLineDash([])
        }
      },
    }
  }, [edges, placedLayouts, cullEpoch])

  /**
   * Cached `--fg-2` token for the dot fill, resolved once on first dot draw.
   * Same lazy-getComputedStyle rationale as {@link edgeColorRef}.
   */
  const dotColorRef = useRef<string | null>(null)

  /**
   * Flat (x, y) buffer of dot world-positions: the placed rows' top-left corners
   * (rebuilt on layout change) OR the module-level synthetic 10k set when the dev
   * toggle is on. A `Float32Array` so the draw loop never allocates per dot.
   * @see docs/specs/v0.4-canvas-mvp.md §12
   */
  const dotPositions = useMemo(() => {
    if (devLod.syntheticDots) return getSyntheticDots()
    const buf = new Float32Array(placedLayouts.length * 2)
    placedLayouts.forEach((row, i) => {
      buf[i * 2] = row.x as number
      buf[i * 2 + 1] = row.y as number
    })
    return buf
  }, [placedLayouts, devLod.syntheticDots])

  /**
   * Dot-tier UnderlayLayer (spec §12): draws every position as one ~3px
   * screen-constant disc. A single `beginPath()` batches all arcs, then one
   * `fill()` paints them — the perf canary for the §16 ink seam. Reuses the
   * generic UnderlayLayer contract (no underlay special-casing).
   */
  const dotsLayer: UnderlayLayer = useMemo(() => {
    const positions = dotPositions
    return {
      draw(ctx: CanvasRenderingContext2D, drawCamera): void {
        if (positions.length === 0) return
        if (dotColorRef.current === null) {
          dotColorRef.current =
            getComputedStyle(document.documentElement).getPropertyValue('--fg-2').trim() ||
            'rgba(0,0,0,0.45)'
        }
        const r = DOT_SCREEN_RADIUS / drawCamera.zoom // screen-constant radius
        ctx.fillStyle = dotColorRef.current
        ctx.beginPath()
        for (let i = 0; i < positions.length; i += 2) {
          // Non-null: i and i+1 are always in bounds (length is even by construction).
          const x = positions[i] as number
          const y = positions[i + 1] as number
          // moveTo before each arc so the implicit line from the previous arc's
          // end isn't part of the path (a single subpath would web all dots).
          ctx.moveTo(x + r, y)
          ctx.arc(x, y, r, 0, Math.PI * 2)
        }
        ctx.fill()
      },
    }
  }, [dotPositions])

  /**
   * Underlay layers array. At the dot tier the dots layer is appended (cards do
   * not render — see below); otherwise it is absent and only edges draw. Identity
   * changes when any layer is rebuilt, triggering the underlay's dirty-mark
   * effect (spec §3 cadence).
   */
  const underlayLayers: UnderlayLayer[] = useMemo(
    () => (tier === 'dot' ? [edgesLayer, dotsLayer] : [edgesLayer]),
    [edgesLayer, dotsLayer, tier],
  )

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

  /**
   * Begin in-place editing of a card (NoteCard double-click → spec §3). No-op
   * when a dot-tier swap has unmounted the cards (defensive — double-click can't
   * reach a card that isn't rendered).
   */
  const handleBeginEdit = useCallback((noteId: string) => setEditingId(noteId), [])

  /**
   * Commit an in-place card edit through the normal save path: `api.notes.update`
   * with the note's existing type round-tripped (the §7 `?`-promotion is
   * creation-mode-only — Plan 3). On success invalidate the feed (`['notes']`),
   * the per-note caches (`['note']` prefix), and the canvas edges (a body change
   * can add/remove a wikilink), then leave edit mode.
   */
  const commitEdit = useMutation({
    mutationFn: ({ id, body, type }: { id: string; body: string; type: NoteType }) =>
      api.notes.update(id, body, type),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['notes'] })
      void queryClient.invalidateQueries({ queryKey: ['note'] })
      void queryClient.invalidateQueries({ queryKey: ['canvas-edges'] })
      setEditingId(null)
    },
  })

  // ---- Visible ids: cards intersecting the inflated viewport rect. Reads the
  // freshly-built in-render index, so it reflects this render's layout + heights.
  const visibleIds = useMemo(() => {
    const { w, h } = viewportSize
    return new Set(index.search(visibleWorldRect(camera, w, h, 1)))
  }, [index, camera, viewportSize])

  // ---- Keep-alive: LRU queue of up to KEEP_ALIVE_SIZE recently-exited cards.
  //
  // Exit-tracking runs DURING render via the setState-during-render pattern (React
  // docs: "storing information from previous renders") so a card is in the keep-
  // alive set on the very render it exits — never unmounted-then-remounted. We use
  // `useState` (not refs) for `prevVisible` and the queue because both are part of
  // the render's transactional output: if React abandons this render (concurrent
  // bailout, Suspense replay, interrupted startTransition — plausible once Plan 3
  // wraps the canvas in Motion transitions), the queued state updates are discarded
  // with it. A ref write would persist past an abandoned render, advancing
  // `prevVisible` to a `visibleIds` that never hit the DOM → next commit
  // mis-classifies exits. The `prevVisible !== visibleIds` guard is the sole
  // trigger and prevents an infinite loop: after `setPrevVisible(visibleIds)` the
  // retry render sees `prevVisible === visibleIds` (visibleIds is a stable useMemo
  // ref across the retry) → guard false → no further setState.
  // @see https://react.dev/reference/react/useState#storing-information-from-previous-renders
  const [prevVisible, setPrevVisible] = useState<Set<string>>(() => new Set())
  const [keepAliveQueue, setKeepAliveQueue] = useState<string[]>([])
  if (prevVisible !== visibleIds) {
    const placedIds = new Set(placedLayouts.map((r) => r.note_id))
    // Newly exited: visible in the previous (committed) render, not visible now.
    const exited = [...prevVisible].filter((id) => !visibleIds.has(id))
    // Most-recent-first, dedup, drop now-visible / unplaced, cap at budget.
    const next: string[] = []
    const seen = new Set<string>()
    for (const id of [...exited, ...keepAliveQueue]) {
      const keep = !seen.has(id) && !visibleIds.has(id) && placedIds.has(id)
      seen.add(id)
      if (keep) next.push(id)
    }
    setPrevVisible(visibleIds)
    setKeepAliveQueue(next.slice(0, KEEP_ALIVE_SIZE))
  }
  const keepAliveIds = useMemo(() => new Set(keepAliveQueue), [keepAliveQueue])

  // ---- Cards to render: visible ∪ keep-alive, sorted by placed_at ascending.
  // At the dot tier no cards (nor the keep-alive set) render — the dots layer
  // stands in for them (spec §12), so the whole DOM card layer is dropped.
  const cardsToRender = useMemo(() => {
    if (tier === 'dot') return EMPTY
    return placedLayouts
      .filter((r) => visibleIds.has(r.note_id) || keepAliveIds.has(r.note_id))
      .sort((a, b) => (a.placed_at ?? 0) - (b.placed_at ?? 0))
  }, [placedLayouts, visibleIds, keepAliveIds, tier])

  // The placed row of the card being edited (if any), for the floating Composer's
  // (x, y) anchor. Null when not editing or the row is gone (e.g. unplaced).
  const editingRow = useMemo(
    () => (editingId ? (placedLayouts.find((r) => r.note_id === editingId) ?? null) : null),
    [editingId, placedLayouts],
  )

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
        <>
          {/* Underlay canvas: painted first so cards sit on top (z-order = DOM order). */}
          <CanvasUnderlay
            camera={camera}
            layers={underlayLayers}
            width={viewportSize.w}
            height={viewportSize.h}
          />
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
                onBeginEdit={handleBeginEdit}
                editing={editingId === r.note_id}
              />
            ))}
            {/* In-place editor: a floating Composer over the hidden card, in the
                same world coordinates so it pans/zooms with the canvas (spec §3). */}
            {editingId !== null && editingRow !== null && (
              <CardEditor
                key={editingId}
                noteId={editingId}
                x={editingRow.x as number}
                y={editingRow.y as number}
                onCommit={(body, type) => commitEdit.mutate({ id: editingId, body, type })}
                onCancel={() => setEditingId(null)}
              />
            )}
          </div>
        </>
      )}
    </div>
  )
}

/**
 * Floating in-place editor for one card. Fetches the note (seeded from the feed
 * cache so it prefills instantly) and renders an edit-mode {@link Composer} at
 * the card's world `(x, y)`. The note's EXISTING type is round-tripped — the §7
 * `?`-promotion is creation-mode-only (Plan 3). Renders nothing until the note
 * is available (the card stays hidden beneath it meanwhile).
 *
 * Why a child component (not inline): it must call the `['note', id]` query hook,
 * which can only run from a component body — and keying it on `noteId` resets the
 * Composer's local body/mode state cleanly when the edited card changes.
 *
 * @see docs/specs/v0.4-canvas-mvp.md §3 (card editing)
 */
function CardEditor({
  noteId,
  x,
  y,
  onCommit,
  onCancel,
}: {
  noteId: string
  x: number
  y: number
  onCommit: (body: string, type: NoteType) => void
  onCancel: () => void
}): React.JSX.Element | null {
  const queryClient = useQueryClient()
  // Same fetch + placeholder seeding as NoteCard so the editor prefills from the
  // already-loaded feed data without a flash. @see src/renderer/src/canvas/NoteCard.tsx
  const { data: note } = useQuery({
    queryKey: ['note', noteId],
    queryFn: () => api.notes.get(noteId),
    placeholderData: () =>
      queryClient.getQueryData<Note[]>(['notes'])?.find((n) => n.id === noteId),
  })
  if (!note) return null
  return (
    <div
      data-canvas-card-editor
      style={{ position: 'absolute', transform: `translate(${x}px, ${y}px)`, width: CARD_WIDTH }}
    >
      <Composer
        initialBody={note.body}
        initialMode={note.type}
        editMode
        onSubmit={({ body, type }) => onCommit(body, type)}
        onCancel={onCancel}
      />
    </div>
  )
}
