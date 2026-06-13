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
import { useHotkeys } from 'react-hotkeys-hook'
import { MANUAL_ARRANGEMENT_ID, ROOT_CANVAS_ID } from '../../../shared/canvas'
import type { Note, NoteType } from '../../../shared/types'
import { Composer } from '../composer/Composer'
import { api } from '../lib/api'
import type { UnderlayLayer } from './CanvasUnderlay'
import { CanvasUnderlay } from './CanvasUnderlay'
import {
  type Camera,
  centerCamera,
  fitCamera,
  type Point,
  screenToWorld,
  visibleWorldRect,
} from './camera'
import { setCanvasDevLod, useCanvasDevLod } from './dev-lod'
import { edgeSegment } from './edge-geometry'
import {
  type CanvasHarnessBridge,
  installHarnessBridge,
  uninstallHarnessBridge,
} from './harness-bridge'
import { tierForZoom } from './lod'
import { NoteCard } from './NoteCard'
import { Picker } from './Picker'
import { CanvasSelectionBar } from './SelectionBar'
import { centroid } from './selection-geometry'
import type { WorldRect } from './spatial-index'
import { CardSpatialIndex } from './spatial-index'
import type { Pos, UndoEntry } from './undo-stack'
import { pushOp, redo as redoStack, undo as undoStack } from './undo-stack'
import { useCanvasCamera } from './useCanvasCamera'
import { useCanvasInteractions } from './useCanvasInteractions'
import { useSpatialUndoStore } from './useSpatialUndoStore'
import { ZeroState } from './ZeroState'

interface Props {
  /** Navigate to (or draft) the note for a clicked `[[slug]]` wikilink. */
  onWikilinkClick: (slug: string) => void
  /** Synchronous dangling-class check for a wikilink slug (render pass). */
  resolveSlug: (slug: string) => boolean
  /**
   * One-shot placement state (spec §6), set by App when "place on canvas…" is
   * chosen from the feed. When non-null the stage shows a top-center banner + a
   * ghost card under the cursor; a click commits the placement and clears it.
   * CanvasStage only CONSUMES this prop — App owns setting/clearing it (Task 10).
   */
  placing?: { noteId: string; title: string } | null
  /** Clear one-shot placement (called on commit or esc-cancel). */
  onPlacingDone?: () => void
  /**
   * Camera seam, UP direction (Task 10 binding seam): report this stage's live
   * zoom so App can render the status-bar zoom pill WITHOUT lifting the camera.
   * The camera state stays here (it owns `viewportRef` + the gesture/persistence/
   * settle effects bound to that node); only the readout flows up.
   * @see docs/plans/v0.4-canvas-mvp-3-placement-chrome.md Task 10 Step 2
   */
  onCameraChange?: (zoom: number) => void
  /**
   * Camera seam, DOWN direction: an incrementing number App bumps to ask the
   * stage to zoom-to-fit all placed cards on its OWN camera (status-bar `fit`).
   * The stage watches for changes (ignoring the initial value) and runs
   * `fitCamera`. Intent flows down; the camera never leaves CanvasStage.
   */
  fitSignal?: number
  /**
   * Camera seam, DOWN direction: an incrementing number App bumps to ask the
   * stage to reset zoom to 100% (status-bar `1:1` / % readout). Same watch-and-
   * run-on-change posture as {@link fitSignal}.
   */
  resetSignal?: number
  /**
   * Jump-to-card request (spec §4/§9/§14): App sets `{id, nonce}` when a feed ▦
   * chip, shelf row, or recent entry asks to jump. The stage pans to center the
   * card + ring-flashes it (the camera lives here). The `nonce` lets a repeat
   * jump to the SAME card re-fire (the id alone wouldn't change).
   */
  jumpTo?: { id: string; nonce: number } | null
}

/**
 * Captured timestamps for a removed layout row, keyed by note id. Stashed at
 * remove time so an undo can `restoreLayouts` with the ORIGINAL `created_at` /
 * `placed_at` rather than re-stamping (which would corrupt the §2 recency rule).
 * @see docs/specs/v0.4-canvas-mvp.md §13
 */
export type LayoutTimestamps = Map<string, { createdAt: number; placedAt: number | null }>

/** IPC surface `applyEntry` drives; the `api.canvas` facade satisfies it. */
type CanvasApi = Pick<
  typeof api.canvas,
  'placeNote' | 'moveNotes' | 'unplaceNotes' | 'restoreLayouts' | 'removeNotes'
>

/**
 * Drive one undo entry's items to their target positions via canvas IPC.
 *
 * `dir==='undo'` moves each item `to`→`from`; `'redo'` moves `from`→`to`. The
 * verb is chosen by the TARGET position (per the {@link undo-stack} mapping):
 *   - `'shelf'`  → `unplaceNotes`
 *   - `'absent'` → `removeNotes`
 *   - `{x,y}`    → `restoreLayouts` when coming FROM `'absent'` (re-insert with
 *     the preserved timestamps from `deps.timestamps`), else `placeNote`.
 *
 * Exported so the remove→undo round-trip is unit-testable headless without a
 * pointer-driven selection (the only way Step 6d can assert timestamp
 * preservation deterministically in happy-dom).
 *
 * @see docs/specs/v0.4-canvas-mvp.md §13
 * @see src/renderer/src/canvas/undo-stack.ts (Pos → IPC verb mapping comment)
 */
export async function applyEntry(
  entry: UndoEntry,
  dir: 'undo' | 'redo',
  deps: { canvas: CanvasApi; timestamps: LayoutTimestamps },
): Promise<void> {
  const key = { canvasId: ROOT_CANVAS_ID, arrangementId: MANUAL_ARRANGEMENT_ID }
  const places: { noteId: string; x: number; y: number }[] = []
  const restores: {
    noteId: string
    x: number | null
    y: number | null
    createdAt: number
    placedAt: number | null
  }[] = []
  const shelves: string[] = []
  const removes: string[] = []

  for (const item of entry.items) {
    const source: Pos = dir === 'undo' ? item.to : item.from
    const target: Pos = dir === 'undo' ? item.from : item.to
    if (target === 'shelf') shelves.push(item.noteId)
    else if (target === 'absent') removes.push(item.noteId)
    else if (source === 'absent') {
      const ts = deps.timestamps.get(item.noteId)
      restores.push({
        noteId: item.noteId,
        x: target.x,
        y: target.y,
        createdAt: ts?.createdAt ?? Date.now(),
        placedAt: ts?.placedAt ?? Date.now(),
      })
    } else places.push({ noteId: item.noteId, x: target.x, y: target.y })
  }

  const calls: Promise<unknown>[] = []
  for (const p of places) calls.push(deps.canvas.placeNote({ ...key, ...p }))
  if (restores.length > 0) calls.push(deps.canvas.restoreLayouts({ ...key, rows: restores }))
  if (shelves.length > 0) calls.push(deps.canvas.unplaceNotes({ ...key, noteIds: shelves }))
  if (removes.length > 0) calls.push(deps.canvas.removeNotes({ ...key, noteIds: removes }))
  await Promise.all(calls)
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
export function CanvasStage({
  onWikilinkClick,
  resolveSlug,
  placing = null,
  onPlacingDone,
  onCameraChange,
  fitSignal,
  resetSignal,
  jumpTo,
}: Props): React.JSX.Element {
  const viewportRef = useRef<HTMLDivElement>(null)
  const queryClient = useQueryClient()

  // ---- DEV LOD overrides (ephemeral store; inert in prod — forceTier defaults
  // 'auto' and the [0.5,2.0] zoom clamp keeps tierForZoom in 'card' normally).
  const devLod = useCanvasDevLod()

  const { camera, setCamera, ready, isMoving } = useCanvasCamera(ROOT_CANVAS_ID, viewportRef, {
    unclampZoom: devLod.unclampZoom,
  })

  // Live camera mirror for the interaction hook's pointer listeners (they read
  // it via a ref so a gesture mid-pan/zoom stays correct — ADR 0006, same
  // posture as useCanvasCamera's own internal cameraRef).
  const cameraRef = useRef(camera)
  cameraRef.current = camera

  // Active tier: a forced tier wins; otherwise zoom decides (spec §12). 'title'
  // and 'card' both render cards as today; only 'dot' swaps to the dot renderer.
  const tier = devLod.forceTier !== 'auto' ? devLod.forceTier : tierForZoom(camera.zoom)

  // ---- In-place card edit (spec §3): which card (by note id) is being edited.
  // Set by a NoteCard double-click; cleared on commit (mutation onSuccess) or
  // Composer esc. While set, that card hides (visibility:hidden, stays mounted so
  // its ResizeObserver measure persists) and a Composer renders over it.
  const [editingId, setEditingId] = useState<string | null>(null)

  // User-facing error from the last in-place save (e.g. duplicate-slug — see
  // src/main/save-note.ts). Mirrors App.tsx's `submitError`: the canvas edit uses
  // the SAME floating Composer (spec §3), so it must surface failures inline
  // rather than swallowing them. Threaded into Composer as `error`; cleared on
  // the next keystroke (`onClearError`), on cancel, and when the edited card
  // changes (the effect below) so a stale error never bleeds into a new edit.
  const [editError, setEditError] = useState<string | null>(null)

  // Clear any stale save-error when the edited card changes (or edit mode exits),
  // so opening a different card never shows a prior card's failure. Mirrors
  // App.tsx's submitError reset on composer-context change.
  // biome-ignore lint/correctness/useExhaustiveDependencies: setEditError is stable
  useEffect(() => {
    setEditError(null)
  }, [editingId])

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

  // ---- Measured-height cache (declared here so placedRects can read it). See
  // handleMeasured below; mutated, not pruned on unplace (bounded by note count).
  const heightCacheRef = useRef(new Map<string, number>())

  // Bumped by handleMeasured when a card's measured height genuinely changes, so
  // the memos that read the (biome-invisible) height cache re-run.
  const [cullEpoch, setCullEpoch] = useState(0)

  /**
   * noteId → world rect, built DURING render from each placed row's real x/y and
   * the measured-height cache. THE single source of card rects: `edgesLayer`,
   * `index`, and the interaction hook (drag/marquee `from`) all read this map so
   * they can never disagree. Why `cullEpoch` is a dep: the height cache is a ref
   * (biome can't see it), so `cullEpoch` gates rebuilds on a height change.
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: cullEpoch gates height-cache reads (heightCacheRef is a stable ref)
  const placedRects = useMemo(() => {
    const m = new Map<string, WorldRect>()
    for (const r of placedLayouts) {
      m.set(r.note_id, {
        x: r.x as number,
        y: r.y as number,
        w: CARD_WIDTH,
        h: heightCacheRef.current.get(r.note_id) ?? DEFAULT_CARD_HEIGHT,
      })
    }
    return m
  }, [placedLayouts, cullEpoch])

  // ---- Edge data: resolved links between placed notes (read-only, spec §11)
  const { data: edges = EMPTY } = useQuery({
    queryKey: ['canvas-edges', ROOT_CANVAS_ID],
    queryFn: () =>
      api.canvas.edges({ canvasId: ROOT_CANVAS_ID, arrangementId: MANUAL_ARRANGEMENT_ID }),
  })

  /**
   * Cached CSS token for edge stroke colour (`--fg-3`), resolved once on first
   * draw. A ref (not state) so it doesn't trigger a re-render when resolved.
   * Why lazy: `getComputedStyle` is a layout read; deferring it to the draw call
   * avoids any pre-paint cost and tolerates test envs where the value is empty.
   */
  const edgeColorRef = useRef<string | null>(null)

  /**
   * UnderlayLayer that draws resolved note edges in world coordinates. Rebuilt
   * on [edges, placedRects] so a new array reference marks the underlay dirty via
   * the `layers` identity change (spec §3 dirty-flag cadence). Reads the shared
   * {@link placedRects} map — the SAME source as culling + the interaction hook.
   */
  const edgesLayer: UnderlayLayer = useMemo(() => {
    const rectByNoteId = placedRects

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
  }, [edges, placedRects])

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
   * Spatial index built DURING render from the shared {@link placedRects} map
   * (each row's real x/y + measured height). Building it in render (not a post-
   * render effect) means `visibleIds` reads a fresh index in the SAME render — no
   * staleness, and no render→effect→setState cull loop. Bug 1 (measure-time origin
   * teleport) is unrepresentable: the rects are always seeded from real x/y.
   */
  const index = useMemo(() => {
    const idx = new CardSpatialIndex()
    idx.rebuild([...placedRects].map(([id, rect]) => ({ id, rect })))
    return idx
  }, [placedRects])

  /**
   * Live mirror of the on-screen card set ({@link visibleIds}, computed below).
   * Held in a ref so {@link hitVisibleAt} can read the latest visible set without
   * the pointer-down / double-click callbacks re-binding every render.
   *
   * Why: the full spatial `index` includes EVERY placed row — culled cards (never
   * rendered) and keep-alive `display:none` cards — and seeds unmeasured cards
   * with {@link DEFAULT_CARD_HEIGHT}. So `index.search(point)` can report a
   * VISUALLY-empty point as occupied (bug B1: create blocked; bug B3: a click
   * routed to a phantom card → reselect instead of deselect). Hit-testing for
   * create-blocking + click-routing must reflect ACTUAL on-screen occupancy, so
   * those two paths filter index hits through this set. Culling + marquee keep
   * using the full index (they legitimately need off-screen rows).
   * @issue utof/linsae#109 (DEFAULT_CARD_HEIGHT over-estimate)
   */
  const visibleIdsRef = useRef<Set<string>>(new Set())

  /**
   * Topmost VISIBLE card whose rect contains world point `w`, or null. Filters
   * the spatial index's hits to {@link visibleIdsRef} so phantom (culled /
   * keep-alive) rects never count as occupancy (see {@link visibleIdsRef}).
   * Topmost = last in DOM/stacking order (index hits are ascending placed_at).
   */
  const hitVisibleAt = useCallback(
    (w: Point): string | null => {
      const hits = index.search({ minX: w.x, minY: w.y, maxX: w.x, maxY: w.y })
      let top: string | null = null
      for (const id of hits) if (visibleIdsRef.current.has(id)) top = id
      return top
    },
    [index],
  )

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
   * can add/remove a wikilink), clear any error, then leave edit mode. On error
   * (e.g. duplicate-slug from save-note.ts) surface the message inline via the
   * Composer's error UI and KEEP the editor open with the user's text intact —
   * feed parity (App.tsx updateMut `onError`).
   */
  const commitEdit = useMutation({
    mutationFn: ({ id, body, type }: { id: string; body: string; type: NoteType }) =>
      api.notes.update(id, body, type),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['notes'] })
      void queryClient.invalidateQueries({ queryKey: ['note'] })
      void queryClient.invalidateQueries({ queryKey: ['canvas-edges'] })
      setEditError(null)
      setEditingId(null)
    },
    onError: (err) => setEditError(err instanceof Error ? err.message : String(err)),
  })

  // ---- Spatial-undo stack (spec §13). The stack is per-WINDOW in-memory and
  // dies on close — but a feed↔canvas toggle unmounts/remounts this stage
  // (App.tsx AnimatePresence mode="wait"), which is NOT a close. useSpatialUndoStore
  // makes the stack + timestamp side-map survive a same-session remount via a
  // query-cache write-through (the camera's mechanism, minus disk). Callers mutate
  // the refs in place then call `persistUndo()`. The reducer (undo-stack.ts) is
  // pure; `applyEntry` (exported above) maps an entry's items to canvas IPC. The
  // timestamp side-map captures removed rows' created_at/placed_at so a
  // restoreLayouts undo reconstructs them with the ORIGINAL timestamps (§13).
  const { undoRef, timestampsRef, persist: persistUndo } = useSpatialUndoStore(ROOT_CANVAS_ID)

  /** Invalidate the canvas queries after any layout write so the surface refreshes. */
  const refreshCanvas = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['canvas-layouts', ROOT_CANVAS_ID] })
    void queryClient.invalidateQueries({ queryKey: ['canvas-edges'] })
    // The recent popover (§14) reads ['canvas-recent', root] via an always-mounted
    // observer under global staleTime:Infinity, so it never auto-refetches —
    // place/move/remove/undo all flow through here, so invalidate it too or the
    // recent list goes stale after every arrange.
    void queryClient.invalidateQueries({ queryKey: ['canvas-recent', ROOT_CANVAS_ID] })
  }, [queryClient])

  /**
   * Record a committed op on the undo stack (coalescing handled by pushOp), then
   * persist so the entry survives a feed↔canvas remount (§13 / useSpatialUndoStore).
   */
  const recordOp = useCallback(
    (entry: UndoEntry) => {
      undoRef.current = pushOp(undoRef.current, entry)
      persistUndo()
    },
    [undoRef, persistUndo],
  )

  const undo = useCallback(async () => {
    const { state, entry } = undoStack(undoRef.current)
    undoRef.current = state
    persistUndo()
    if (!entry) return
    await applyEntry(entry, 'undo', { canvas: api.canvas, timestamps: timestampsRef.current })
    refreshCanvas()
  }, [refreshCanvas, undoRef, timestampsRef, persistUndo])

  const redo = useCallback(async () => {
    const { state, entry } = redoStack(undoRef.current)
    undoRef.current = state
    persistUndo()
    if (!entry) return
    await applyEntry(entry, 'redo', { canvas: api.canvas, timestamps: timestampsRef.current })
    refreshCanvas()
  }, [refreshCanvas, undoRef, timestampsRef, persistUndo])

  // Spatial undo/redo (spec §13/§15). Bound HERE because the stack ref is private
  // to CanvasStage — App can't reach it. CanvasStage only mounts on the canvas
  // view (App.tsx), so the binding is implicitly canvas-scoped; no viewMode gate
  // needed. The REST of the canvas key map + the esc cascade are Task 11's.
  useHotkeys('mod+z', (e) => {
    e.preventDefault()
    void undo()
  })
  useHotkeys('shift+mod+z', (e) => {
    e.preventDefault()
    void redo()
  })

  // ---- Drag/nudge commits: turn the hook's moves into placeNote + an undo
  // entry. A move's `from`/`to` are both `{x,y}`, so undo replays placeNote at
  // the prior coords. `onCommitNudge` stamps `at` so the reducer coalesces a
  // nudge burst into one undo entry (undo-stack COALESCE_MS).
  const commitMoves = useCallback(
    (moves: { noteId: string; from: Point; to: Point }[], coalesce: boolean) => {
      const key = { canvasId: ROOT_CANVAS_ID, arrangementId: MANUAL_ARRANGEMENT_ID }
      void api.canvas.moveNotes({
        ...key,
        moves: moves.map((m) => ({ ...m.to, noteId: m.noteId })),
      })
      recordOp({
        op: 'move',
        items: moves.map((m) => ({ noteId: m.noteId, from: m.from, to: m.to })),
        ...(coalesce ? { at: Date.now() } : {}),
      })
      refreshCanvas()
    },
    [recordOp, refreshCanvas],
  )
  const onCommitMove = useCallback(
    (moves: { noteId: string; from: Point; to: Point }[]) => commitMoves(moves, false),
    [commitMoves],
  )
  const onCommitNudge = useCallback(
    (moves: { noteId: string; from: Point; to: Point }[]) => commitMoves(moves, true),
    [commitMoves],
  )

  // ---- Interaction hook (selection + drag/marquee/nudge). Reads placedRects +
  // index live; commits flow back through the callbacks above.
  const interactions = useCanvasInteractions({
    cameraRef,
    viewportRef,
    placedRects,
    index,
    onCommitMove,
    onCommitNudge,
  })

  /**
   * Place a note at a world point + record the undo entry. `from` is `'shelf'`
   * if the note was already shelved (a NULL-xy layout row exists), else
   * `'absent'`; undo then reshelves or removes the row accordingly (§13). Used by
   * the picker, the one-shot ghost, and (with `from:'absent'`) create-on-canvas.
   */
  const placeAt = useCallback(
    (noteId: string, p: Point, from: Pos) => {
      const key = { canvasId: ROOT_CANVAS_ID, arrangementId: MANUAL_ARRANGEMENT_ID }
      void api.canvas.placeNote({ ...key, noteId, x: p.x, y: p.y })
      recordOp({ op: 'place', items: [{ noteId, from, to: { x: p.x, y: p.y } }] })
      refreshCanvas()
    },
    [recordOp, refreshCanvas],
  )

  /** True if `noteId` has a (shelved) layout row already — picker `from` choice. */
  const isShelved = useCallback(
    (noteId: string) => layouts.some((r) => r.note_id === noteId && r.x === null),
    [layouts],
  )

  // ---- Camera helpers for jump-to-card (picker ▦ jump, recent, ▦ chips). Pans
  // to center the card and flashes its ring. `ringFlashId` paints a transient
  // accent ring (selection treatment, reused) cleared after a short timeout.
  const [ringFlashId, setRingFlashId] = useState<string | null>(null)
  const ringTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const flashRing = useCallback((noteId: string) => {
    if (ringTimerRef.current) clearTimeout(ringTimerRef.current)
    setRingFlashId(noteId)
    ringTimerRef.current = setTimeout(() => setRingFlashId(null), 900)
  }, [])
  useEffect(() => () => void (ringTimerRef.current && clearTimeout(ringTimerRef.current)), [])

  const jumpToCard = useCallback(
    (noteId: string) => {
      const rect = placedRects.get(noteId)
      if (!rect) return
      const { w, h } = viewportSize
      setCamera((c) => centerCamera(rect, w, h, c.zoom))
      flashRing(noteId)
    },
    [placedRects, viewportSize, setCamera, flashRing],
  )

  // ---- Camera seam, UP direction (Task 10 §14): report live zoom so App can
  // render the status-bar pill without lifting the camera. Fires only when the
  // rounded percentage actually changes (a continuous-pinch zoom otherwise spams
  // App with sub-percent updates). onCameraChange is optional + caller-stable.
  useEffect(() => {
    onCameraChange?.(camera.zoom)
  }, [camera.zoom, onCameraChange])

  // ---- Camera seam, DOWN direction (Task 10 §14): App bumps fitSignal/resetSignal
  // to drive fit / 100%-reset on THIS stage's own camera. A ref tracks the last
  // value so the effect ignores the initial mount and fires only on a real bump.
  const fitSignalRef = useRef(fitSignal)
  useEffect(() => {
    if (fitSignal === fitSignalRef.current) return
    fitSignalRef.current = fitSignal
    setCamera((c) => fitCamera([...placedRects.values()], viewportSize.w, viewportSize.h, 48, c))
  }, [fitSignal, setCamera, placedRects, viewportSize])
  const resetSignalRef = useRef(resetSignal)
  useEffect(() => {
    if (resetSignal === resetSignalRef.current) return
    resetSignalRef.current = resetSignal
    setCamera((c) => ({ ...c, zoom: 1 }))
  }, [resetSignal, setCamera])

  // ---- Harness control bridge (spec §3 / §17). Attached ONLY when the preload
  // reports isHarness (LINSAE_HARNESS=1) — inert in every normal launch. Lets the
  // Playwright perf harness drive a deterministic camera path + force the dot
  // tier. setCamera/cameraRef are this stage's own; setDevLod hits the module store.
  // @see scripts/canvas-perf-harness.mjs
  useEffect(() => {
    if (!window.api.isHarness) return
    const bridge: CanvasHarnessBridge = {
      setCamera: (cam) => setCamera(cam),
      getCamera: () => cameraRef.current,
      setDevLod: (patch) => setCanvasDevLod(patch),
    }
    installHarnessBridge(bridge)
    return () => uninstallHarnessBridge()
  }, [setCamera])

  // ---- Jump-to-card request from App (§4/§9/§14). A nonce ref dedupes so the
  // same request fires once; jumpToCard is in the deps because the layouts query
  // can resolve AFTER the request (App switches view → stage mounts → fetches),
  // so a jump whose card isn't placed yet retries when placedRects fills in.
  const jumpNonceRef = useRef<number | null>(null)
  useEffect(() => {
    if (!jumpTo) return
    if (jumpNonceRef.current === jumpTo.nonce) return
    const rect = placedRects.get(jumpTo.id)
    if (!rect) return // card not placed yet — retry when placedRects updates
    jumpNonceRef.current = jumpTo.nonce
    jumpToCard(jumpTo.id)
  }, [jumpTo, jumpToCard, placedRects])

  // ---- `/` picker state. `pickerAnchor` is the viewport-relative SCREEN point
  // where the picker floats (= the intended drop point). Task 11 binds `/` to
  // open it; here we own the mount + pick/jump/close wiring.
  const [pickerAnchor, setPickerAnchor] = useState<{ x: number; y: number } | null>(null)
  const placedNoteIds = useMemo(() => new Set(placedRects.keys()), [placedRects])

  // Last pointer position (viewport-relative screen px) so `/` can open the picker
  // at the cursor (spec §15). Null until the first pointermove over the viewport;
  // `openPickerAtCursor` falls back to the viewport center when the pointer is
  // outside the canvas (§15: "pointer outside the canvas viewport → anchor at
  // viewport center"). A ref (not state) — read only at `/`-press, never rendered.
  const lastPointerRef = useRef<{ x: number; y: number } | null>(null)
  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    const onMove = (e: PointerEvent) => {
      const rect = viewport.getBoundingClientRect()
      lastPointerRef.current = { x: e.clientX - rect.left, y: e.clientY - rect.top }
    }
    const onLeave = () => {
      lastPointerRef.current = null
    }
    viewport.addEventListener('pointermove', onMove)
    viewport.addEventListener('pointerleave', onLeave)
    return () => {
      viewport.removeEventListener('pointermove', onMove)
      viewport.removeEventListener('pointerleave', onLeave)
    }
  }, [])

  const onPick = useCallback(
    (noteId: string, opts: { keepOpen: boolean }) => {
      const camera = cameraRef.current
      const anchor = pickerAnchor
      if (!camera || !anchor) return
      const world = screenToWorld(camera, anchor)
      placeAt(noteId, world, isShelved(noteId) ? 'shelf' : 'absent')
      if (opts.keepOpen) setPickerAnchor({ x: anchor.x + 24, y: anchor.y + 24 })
      else setPickerAnchor(null)
    },
    [pickerAnchor, placeAt, isShelved],
  )

  /**
   * Open the `/` picker at the last cursor position, or the viewport center when
   * the pointer is outside the canvas (spec §15). The anchor is the intended drop
   * point in viewport-relative SCREEN px; `onPick` converts it to world coords.
   */
  const openPickerAtCursor = useCallback(() => {
    const p = lastPointerRef.current ?? { x: viewportSize.w / 2, y: viewportSize.h / 2 }
    setPickerAnchor(p)
  }, [viewportSize])

  // ---- One-shot ghost (spec §6, receiving side). App sets the `placing` prop;
  // we track the live cursor world point so the ghost follows it, and commit on
  // a click. `ghostWorld` is updated by a pointermove listener while `placing`.
  const [ghostWorld, setGhostWorld] = useState<Point | null>(null)
  useEffect(() => {
    const viewport = viewportRef.current
    if (!placing || !viewport) {
      setGhostWorld(null)
      return
    }
    const onMove = (e: PointerEvent) => {
      const camera = cameraRef.current
      if (!camera) return
      const rect = viewport.getBoundingClientRect()
      setGhostWorld(screenToWorld(camera, { x: e.clientX - rect.left, y: e.clientY - rect.top }))
    }
    const onClick = (e: MouseEvent) => {
      const camera = cameraRef.current
      // Only a primary (left) click commits — right/middle clicks during
      // placement must not drop (parity with onWorldPointerDown's button guard).
      if (e.button !== 0 || !camera) return
      const rect = viewport.getBoundingClientRect()
      const world = screenToWorld(camera, { x: e.clientX - rect.left, y: e.clientY - rect.top })
      placeAt(placing.noteId, world, 'absent')
      flashRing(placing.noteId)
      onPlacingDone?.()
    }
    viewport.addEventListener('pointermove', onMove)
    viewport.addEventListener('click', onClick)
    return () => {
      viewport.removeEventListener('pointermove', onMove)
      viewport.removeEventListener('click', onClick)
    }
  }, [placing, placeAt, flashRing, onPlacingDone])

  // ---- Create-on-canvas (spec §7). Double-click the empty surface opens a
  // floating create-mode Composer at the double-clicked world point; ↵ creates +
  // places in one transaction (single timestamp — api.canvas.createNoteAt).
  const [createAt, setCreateAt] = useState<Point | null>(null)
  const createMut = useMutation({
    mutationFn: (input: { body: string; type: NoteType; x: number; y: number }) =>
      api.canvas.createNoteAt({
        canvasId: ROOT_CANVAS_ID,
        arrangementId: MANUAL_ARRANGEMENT_ID,
        body: input.body,
        type: input.type,
        x: input.x,
        y: input.y,
      }),
    onSuccess: (note, vars) => {
      void queryClient.invalidateQueries({ queryKey: ['notes'] })
      void queryClient.invalidateQueries({ queryKey: ['note'] })
      refreshCanvas()
      // The note stays in the feed on undo — only the layout row is removed (§13),
      // so the create place op records `from:'absent'`.
      recordOp({
        op: 'place',
        items: [{ noteId: note.id, from: 'absent', to: { x: vars.x, y: vars.y } }],
      })
      setCreateAt(null)
    },
  })

  /** Double-click on the EMPTY world surface → open the create composer there. */
  const onSurfaceDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      const viewport = viewportRef.current
      const camera = cameraRef.current
      if (!viewport || !camera) return
      const rect = viewport.getBoundingClientRect()
      const w = screenToWorld(camera, { x: e.clientX - rect.left, y: e.clientY - rect.top })
      // Only the EMPTY surface creates — a double-click over a VISIBLE card begins
      // that card's in-place edit (NoteCard's own dblclick), so skip create there.
      // hitVisibleAt (not raw index.search) so a phantom culled/keep-alive rect
      // over a visually-empty point never blocks create (bug B1).
      if (hitVisibleAt(w) !== null) return
      setCreateAt(w)
    },
    [hitVisibleAt],
  )

  // ---- Pointer-down dispatch on the world surface (spec §8). A pointerdown over
  // a card begins a (group) drag; over empty surface it begins a marquee. We hit-
  // test the shared `index` at the pointer's world point rather than wiring a
  // per-card handler — that keeps NoteCard's DOM (and the keep-alive structural
  // test) untouched. Space/middle-drag pan is owned by useCanvasCamera and takes
  // precedence (it preventDefaults the space gesture before this fires).
  const onWorldPointerDown = useCallback(
    (e: React.PointerEvent) => {
      const viewport = viewportRef.current
      const camera = cameraRef.current
      // While one-shot placing, the surface is the drop target — the DOM `click`
      // listener commits the placement; no marquee/drag should begin.
      if (e.button !== 0 || !viewport || !camera || placing) return
      const rect = viewport.getBoundingClientRect()
      const w = screenToWorld(camera, { x: e.clientX - rect.left, y: e.clientY - rect.top })
      // hitVisibleAt (not raw index.search) so a click on a VISUALLY-empty point
      // that only overlaps a phantom culled/keep-alive rect routes to the surface
      // (marquee/deselect), not onCardPointerDown — which would reselect the
      // phantom instead of clearing the selection (bug B3 misroute).
      const top = hitVisibleAt(w)
      if (top !== null) interactions.onCardPointerDown(e, top)
      else interactions.onSurfacePointerDown(e)
    },
    [hitVisibleAt, interactions, placing],
  )

  // ---- Selection-bar verbs (spec §8). `selectedIds` comes from the hook.
  const { selectedIds, clearSelection } = interactions
  const dragOffset = interactions.dragOffset
  const marquee = interactions.marquee

  /** Remove the selected layout rows (notes stay in the feed). Undoable (§13). */
  // biome-ignore lint/correctness/useExhaustiveDependencies: timestampsRef is a stable ref from useSpatialUndoStore (its .set is not a reactive dep)
  const onRemove = useCallback(() => {
    const ids = [...selectedIds]
    if (ids.length === 0) return
    // Capture full row data FIRST so undo can restoreLayouts with timestamps.
    const items: UndoEntry['items'] = []
    for (const id of ids) {
      const row = layouts.find((r) => r.note_id === id)
      if (!row || row.x === null || row.y === null) continue
      timestampsRef.current.set(id, { createdAt: row.created_at, placedAt: row.placed_at })
      items.push({ noteId: id, from: { x: row.x, y: row.y }, to: 'absent' })
    }
    if (items.length === 0) return
    const key = { canvasId: ROOT_CANVAS_ID, arrangementId: MANUAL_ARRANGEMENT_ID }
    void api.canvas.removeNotes({ ...key, noteIds: items.map((i) => i.noteId) })
    // recordOp persists the stack AND the just-set timestamps together (it reads
    // timestampsRef.current live), so an undo restores rows with original stamps.
    recordOp({ op: 'remove', items })
    clearSelection()
    refreshCanvas()
  }, [selectedIds, layouts, recordOp, clearSelection, refreshCanvas])

  /** Delete the selected notes everywhere (confirm-gated, NOT undoable — §13). */
  const onDeleteRequest = useCallback(() => {
    const ids = [...selectedIds]
    if (ids.length === 0) return
    const ok = window.confirm(
      `delete ${ids.length} note(s) everywhere? this cannot be undone here.`,
    )
    if (!ok) return
    for (const id of ids) void api.notes.delete(id)
    clearSelection()
  }, [selectedIds, clearSelection])

  // ---- Canvas key map (spec §15). CanvasStage only mounts on the canvas view
  // (App.tsx AnimatePresence), so every binding here is implicitly canvas-scoped —
  // no viewMode prop needed (same posture as the mod+z/shift+mod+z bindings
  // above). `enableOnFormTags` is off (the default) so none fire while typing in
  // the create/edit Composer or the picker input. mod+1/mod+2/mod+k/mod+j stay in
  // App (their state lives there). The esc cascade is a CAPTURE-phase listener
  // (see below) — not a useHotkeys binding — so it can win over App's esc ladder.

  // `/` → open the picker at the cursor. Gated NOT-while-placing (§15: "not in
  // one-shot mode") and not when the picker is already open (avoids re-anchoring
  // an open picker). The `useKey:true` default-off means `/` matches the physical
  // slash key. preventDefault so the `/` char isn't typed into a focused field.
  useHotkeys(
    'slash',
    (e) => {
      if (placing || pickerAnchor) return
      e.preventDefault()
      openPickerAtCursor()
    },
    [placing, pickerAnchor, openPickerAtCursor],
  )
  // ⇧1 → zoom-to-fit, ⇧0 → 100%. PHYSICAL-key bindings (react-hotkeys-hook v5
  // default; do NOT pass useKey — that would match the produced '!'/')' and is
  // wrong, spec §15). Fit reuses the SAME fitCamera path as fitSignal / the
  // centroid arrow; reset mirrors resetSignal. Fit with zero placed = no-op
  // (fitCamera returns the current camera when the rect list is empty).
  useHotkeys(
    'shift+1',
    (e) => {
      e.preventDefault()
      setCamera((c) => fitCamera([...placedRects.values()], viewportSize.w, viewportSize.h, 48, c))
    },
    [setCamera, placedRects, viewportSize],
  )
  useHotkeys(
    'shift+0',
    (e) => {
      e.preventDefault()
      setCamera((c) => ({ ...c, zoom: 1 }))
    },
    [setCamera],
  )
  // arrows → nudge the selection 8 px (spec §8/§15). nudge() no-ops + returns
  // false when the selection is empty, so the gate is the hook's own check.
  // e.key is 'ArrowUp'/etc — exactly what nudgeDelta expects.
  useHotkeys(
    'up,down,left,right',
    (e) => {
      if (interactions.nudge(e.key)) e.preventDefault()
    },
    [interactions],
  )
  // ⌫/⌦ → remove the selection from the canvas (the SelectionBar's onRemove).
  // onRemove no-ops when the selection is empty (spec §15: selection ≠ ∅).
  useHotkeys(
    'backspace,delete',
    (e) => {
      if (selectedIds.size === 0) return
      e.preventDefault()
      onRemove()
    },
    [selectedIds, onRemove],
  )

  // ---- The esc cascade (spec §15). ONE consumer per press, in order:
  //   composer/edit card → drag (cancelDrag) → picker → one-shot placement →
  //   marquee (folded into cancelDrag) → selection (clear) → no-op.
  //
  // Mechanism — why this wins over App's esc ladder deterministically: this is a
  // native CAPTURE-phase keydown listener on the canvas VIEWPORT node. An esc
  // dispatched inside the canvas (focus on the viewport, a card, the create/edit
  // Composer, or the picker input — all descendants of the viewport) is seen here
  // DURING the capture descent, BEFORE it bubbles up to the document where App's
  // esc useHotkeys (bubble phase) sits. When we consume a step we call
  // stopPropagation(), so the event never bubbles to App. Precedence is by
  // event-phase + DOM position — NOT react-hotkeys-hook registration order (which
  // is undefined between two document listeners). A capture listener on the
  // viewport (a tight subtree) also means esc OUTSIDE the canvas never reaches it.
  //
  // #118: the drag AND marquee §15 steps both collapse into cancelDrag()'s RETURN
  // VALUE — they are the same consumer internally (useCanvasInteractions) but only
  // one can be active at a time, so the collapse is correct. We branch on the
  // boolean (NOT interactions.dragging) so a captured-but-unmoved pointer — where
  // `dragging` is still false but a drag session exists — is still cancelled.
  //
  // Step 1 (composer/edit card): the create Composer's plain-esc does NOT
  // stopPropagation (only edit/question mode does — Composer.tsx:148), and even
  // edit-mode's React onKeyDown fires at the TARGET during bubble, AFTER this
  // capture handler. So we own closing BOTH the create composer (createAt) and the
  // in-place editor (editingId) here; consuming + stopPropagation makes the
  // Composer's own handler moot (idempotent — both would close it).
  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    const onEsc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      const consume = () => e.stopPropagation()
      if (createAt !== null || editingId !== null) {
        setCreateAt(null)
        setEditingId(null)
        return consume()
      }
      if (interactions.cancelDrag()) return consume() // drag OR marquee (#118)
      if (pickerAnchor !== null) {
        setPickerAnchor(null)
        return consume()
      }
      if (placing) {
        onPlacingDone?.()
        return consume()
      }
      if (selectedIds.size > 0) {
        clearSelection()
        return consume()
      }
      // No-op: nothing canvas-owned to consume → let App's esc ladder resolve.
    }
    viewport.addEventListener('keydown', onEsc, { capture: true })
    return () => viewport.removeEventListener('keydown', onEsc, { capture: true })
  }, [
    createAt,
    editingId,
    interactions,
    pickerAnchor,
    placing,
    onPlacingDone,
    selectedIds,
    clearSelection,
  ])

  // ---- Visible ids: cards intersecting the inflated viewport rect. Reads the
  // freshly-built in-render index, so it reflects this render's layout + heights.
  const visibleIds = useMemo(() => {
    const { w, h } = viewportSize
    return new Set(index.search(visibleWorldRect(camera, w, h, 1)))
  }, [index, camera, viewportSize])
  // Mirror into the ref read by hitVisibleAt (create-block + click-routing). Set
  // during render — same posture as cameraRef above; the pointer/dblclick
  // listeners read it at event time (post-commit), never mid-render.
  visibleIdsRef.current = visibleIds

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

  // Selection-bar anchor: a few px above the selection's bounding box, in
  // viewport SCREEN coords (the bar lives in untransformed overlay space). Null
  // when nothing is selected. Recomputed as the camera or selection changes so
  // the bar tracks the cards. Hidden mid-drag to avoid jitter (offset is
  // transient until drop).
  const selectionBarPos = useMemo(() => {
    if (selectedIds.size === 0 || dragOffset) return null
    let minX = Number.POSITIVE_INFINITY
    let minY = Number.POSITIVE_INFINITY
    for (const id of selectedIds) {
      const r = placedRects.get(id)
      if (!r) continue
      minX = Math.min(minX, r.x)
      minY = Math.min(minY, r.y)
    }
    if (!Number.isFinite(minX)) return null
    const sx = (minX - camera.x) * camera.zoom
    const sy = (minY - camera.y) * camera.zoom
    return { x: sx, y: sy - 44 }
  }, [selectedIds, placedRects, camera, dragOffset])

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
          {/* biome-ignore lint/a11y/noStaticElementInteractions: the world is a spatial surface; pointer/dblclick drive marquee+drag+create — keyboard is the canvas-scoped hotkey map (Task 11), not per-element handlers */}
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
            onPointerDown={onWorldPointerDown}
            onDoubleClick={onSurfaceDoubleClick}
          >
            {cardsToRender.map((r) => {
              // While dragging, selected cards follow the live offset transiently
              // (the move is persisted only on drop — spec §8). ringFlashId reuses
              // the selection treatment to flash a jumped-to card (spec §4/§5/§9).
              const isSel = selectedIds.has(r.note_id)
              const dx = isSel && dragOffset ? dragOffset.dx : 0
              const dy = isSel && dragOffset ? dragOffset.dy : 0
              return (
                <NoteCard
                  key={r.note_id}
                  noteId={r.note_id}
                  x={(r.x as number) + dx}
                  y={(r.y as number) + dy}
                  keptAlive={keepAliveIds.has(r.note_id) && !visibleIds.has(r.note_id)}
                  isMoving={isMoving}
                  onMeasured={handleMeasured}
                  onWikilinkClick={onWikilinkClick}
                  resolveSlug={resolveSlug}
                  onBeginEdit={handleBeginEdit}
                  editing={editingId === r.note_id}
                  selected={isSel || ringFlashId === r.note_id}
                />
              )
            })}
            {/* Marquee rubber-band (quiet) — world coords, drawn while selecting. */}
            {marquee && (
              <div
                data-canvas-marquee
                aria-hidden="true"
                style={{
                  position: 'absolute',
                  left: marquee.minX,
                  top: marquee.minY,
                  width: marquee.maxX - marquee.minX,
                  height: marquee.maxY - marquee.minY,
                  border: '1px solid var(--accent)',
                  background: 'color-mix(in srgb, var(--accent) 12%, transparent)',
                  pointerEvents: 'none',
                }}
              />
            )}
            {/* One-shot ghost (spec §6): real-size card preview following the cursor. */}
            {placing && ghostWorld && (
              <div
                data-canvas-ghost
                aria-hidden="true"
                style={{
                  position: 'absolute',
                  transform: `translate(${ghostWorld.x}px, ${ghostWorld.y}px)`,
                  width: CARD_WIDTH,
                  minHeight: DEFAULT_CARD_HEIGHT,
                  // Matches NoteCard's shell fill EXACTLY (NoteCard.tsx:156) so
                  // the ghost reads as the card it previews. The white card fill
                  // is a literal in this codebase (not a token): `--bg-0` is
                  // semantically the CANVAS background, so reusing it here would
                  // make the ghost blend into a themed canvas instead of standing
                  // against it. @see src/renderer/src/canvas/NoteCard.tsx
                  background: '#FFFFFF',
                  border: '1px dashed var(--accent)',
                  borderRadius: 'var(--r-3)',
                  boxShadow: 'var(--shadow-2)',
                  opacity: 0.7,
                  padding: '12px 14px 10px',
                  pointerEvents: 'none',
                }}
              >
                {placing.title}
              </div>
            )}
            {/* Create-on-canvas (spec §7): floating create-mode Composer at the
                double-clicked world point. ↵ creates+places (single timestamp). */}
            {createAt && (
              <div
                data-canvas-create
                style={{
                  position: 'absolute',
                  transform: `translate(${createAt.x}px, ${createAt.y}px)`,
                  width: CARD_WIDTH,
                }}
              >
                <Composer
                  initialBody=""
                  initialMode="claim"
                  onSubmit={({ body, type }) =>
                    createMut.mutate({ body, type, x: createAt.x, y: createAt.y })
                  }
                  onCancel={() => setCreateAt(null)}
                />
              </div>
            )}
            {/* In-place editor: a floating Composer over the hidden card, in the
                same world coordinates so it pans/zooms with the canvas (spec §3). */}
            {editingId !== null && editingRow !== null && (
              <CardEditor
                key={editingId}
                noteId={editingId}
                x={editingRow.x as number}
                y={editingRow.y as number}
                error={editError}
                onClearError={() => setEditError(null)}
                onCommit={(body, type) => commitEdit.mutate({ id: editingId, body, type })}
                onCancel={() => {
                  setEditError(null)
                  setEditingId(null)
                }}
              />
            )}
          </div>
          {/* One-shot placement banner (spec §6) — top-center, viewport space. */}
          {placing && (
            <div
              data-canvas-placing-banner
              style={{
                position: 'absolute',
                top: 12,
                left: '50%',
                transform: 'translateX(-50%)',
                background: 'var(--bg-1)',
                border: '1px solid var(--border-0)',
                borderRadius: 8,
                padding: '6px 12px',
                fontSize: 12,
                fontFamily: 'var(--font-sans)',
                color: 'var(--fg-1)',
                boxShadow: 'var(--shadow-1)',
                pointerEvents: 'none',
              }}
            >
              {`placing "${placing.title}" — click to drop · esc to cancel`}
            </div>
          )}
          {/* Selection bar (spec §8) — floating quiet bar, viewport space. */}
          {selectionBarPos && (
            <div
              style={{
                position: 'absolute',
                left: selectionBarPos.x,
                top: selectionBarPos.y,
                pointerEvents: 'none',
              }}
            >
              <CanvasSelectionBar
                count={selectedIds.size}
                onRemove={onRemove}
                onDeleteRequest={onDeleteRequest}
              />
            </div>
          )}
          {/* `/` picker (spec §5) — floats at the cursor screen point. */}
          {pickerAnchor && (
            <Picker
              anchor={pickerAnchor}
              placedNoteIds={placedNoteIds}
              onPick={onPick}
              onJump={(id) => {
                jumpToCard(id)
                setPickerAnchor(null)
              }}
              onClose={() => setPickerAnchor(null)}
            />
          )}
          {/* Zero state (spec §14): centered in the viewport, shown when no cards
              are placed. Follows the camera (viewport-space, not world-space). */}
          <div
            aria-hidden={placedLayouts.length > 0}
            style={{
              position: 'absolute',
              inset: 0,
              display: 'grid',
              placeItems: 'center',
              pointerEvents: 'none',
            }}
          >
            <ZeroState visible={placedLayouts.length === 0} />
          </div>
          {/* Centroid arrow (spec §14 G2): quiet pill pointing toward the placed-
              cards centroid when ≥1 card exists but none intersect the viewport.
              Click → zoom-to-fit. The arrow glyph (↑↗→↘↓↙←↖) tracks the angle
              from the viewport center to the centroid world point. */}
          <CentroidArrow
            placedLayouts={placedLayouts}
            visibleIds={visibleIds}
            placedRects={placedRects}
            camera={camera}
            viewportSize={viewportSize}
            onFit={() =>
              setCamera((c) =>
                fitCamera([...placedRects.values()], viewportSize.w, viewportSize.h, 48, c),
              )
            }
          />
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
  error,
  onClearError,
  onCommit,
  onCancel,
}: {
  noteId: string
  x: number
  y: number
  /** Inline save-error message (e.g. duplicate-slug); null when no error. */
  error: string | null
  /** Drop the error on the next keystroke (feed parity — App.tsx). */
  onClearError: () => void
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
        error={error}
        onClearError={onClearError}
        onSubmit={({ body, type }) => onCommit(body, type)}
        onCancel={onCancel}
      />
    </div>
  )
}

/**
 * Orientation pill shown when ≥1 card is placed but none intersect the viewport
 * (§14 G2). The arrow glyph is computed from the angle between the viewport
 * center and the placed-cards centroid (world space), giving the user a spatial
 * hint. Click = zoom-to-fit.
 *
 * Why a child component: reads `placedRects.values()` for the centroid call,
 * which is a Map iterator — not a stable value — so placing the logic here keeps
 * the `centroid` import away from the CanvasStage render body (no extra render).
 *
 * @see docs/specs/v0.4-canvas-mvp.md §14 (G2 centroid arrow)
 * @see src/renderer/src/canvas/selection-geometry.ts (centroid)
 * @see src/renderer/src/canvas/camera.ts (fitCamera)
 */
function CentroidArrow({
  placedLayouts,
  visibleIds,
  placedRects,
  camera,
  viewportSize,
  onFit,
}: {
  placedLayouts: { note_id: string }[]
  visibleIds: Set<string>
  placedRects: Map<string, WorldRect>
  camera: Camera
  viewportSize: { w: number; h: number }
  onFit: () => void
}): React.JSX.Element | null {
  // Only show when cards exist but none are visible in the viewport.
  if (placedLayouts.length === 0 || visibleIds.size > 0) return null

  const c = centroid([...placedRects.values()])
  if (!c) return null

  // Camera viewport center in world coordinates.
  const vcx = camera.x + viewportSize.w / camera.zoom / 2
  const vcy = camera.y + viewportSize.h / camera.zoom / 2

  // Angle from viewport center to centroid; map to an octant arrow glyph.
  const dx = c.x - vcx
  const dy = c.y - vcy
  const angle = Math.atan2(dy, dx) * (180 / Math.PI) // degrees, -180..180
  // 8-directional arrows mapped from angle: right=0, down=90, left=±180, up=-90.
  let arrow = '→'
  if (angle >= -22.5 && angle < 22.5) arrow = '→'
  else if (angle >= 22.5 && angle < 67.5) arrow = '↘'
  else if (angle >= 67.5 && angle < 112.5) arrow = '↓'
  else if (angle >= 112.5 && angle < 157.5) arrow = '↙'
  else if (angle >= 157.5 || angle < -157.5) arrow = '←'
  else if (angle >= -157.5 && angle < -112.5) arrow = '↖'
  else if (angle >= -112.5 && angle < -67.5) arrow = '↑'
  else arrow = '↗'

  return (
    <div
      style={{
        position: 'absolute',
        bottom: 16,
        left: '50%',
        transform: 'translateX(-50%)',
        pointerEvents: 'auto',
      }}
    >
      <button
        type="button"
        data-canvas-centroid-arrow
        onClick={onFit}
        title="zoom to fit all cards"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          padding: '5px 12px',
          background: 'var(--bg-1)',
          border: '1px solid var(--border-0)',
          borderRadius: 'var(--r-pill)',
          boxShadow: 'var(--shadow-1)',
          cursor: 'pointer',
          fontFamily: 'var(--font-sans)',
          fontSize: 'var(--t-12)',
          color: 'var(--fg-2)',
          whiteSpace: 'nowrap',
        }}
      >
        <span aria-hidden="true">{arrow}</span> back to your notes
      </button>
    </div>
  )
}
