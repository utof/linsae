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
import { centerCamera, type Point, screenToWorld, visibleWorldRect } from './camera'
import { useCanvasDevLod } from './dev-lod'
import { edgeSegment } from './edge-geometry'
import { tierForZoom } from './lod'
import { NoteCard } from './NoteCard'
import { Picker } from './Picker'
import { CanvasSelectionBar } from './SelectionBar'
import type { WorldRect } from './spatial-index'
import { CardSpatialIndex } from './spatial-index'
import type { Pos, UndoEntry } from './undo-stack'
import { emptyUndo, pushOp, redo as redoStack, undo as undoStack } from './undo-stack'
import { useCanvasCamera } from './useCanvasCamera'
import { useCanvasInteractions } from './useCanvasInteractions'

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

  // ---- Spatial-undo stack (spec §13). A render-stable ref: the stack is
  // per-window in-memory and dies on close. The reducer (undo-stack.ts) is pure;
  // `applyEntry` (exported above) maps an entry's items to canvas IPC. The
  // timestamp side-map captures removed rows' created_at/placed_at so a
  // restoreLayouts undo reconstructs them with the ORIGINAL timestamps (§13).
  const undoRef = useRef(emptyUndo())
  const timestampsRef = useRef<LayoutTimestamps>(new Map())

  /** Invalidate the canvas queries after any layout write so the surface refreshes. */
  const refreshCanvas = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['canvas-layouts', ROOT_CANVAS_ID] })
    void queryClient.invalidateQueries({ queryKey: ['canvas-edges'] })
  }, [queryClient])

  /** Record a committed op on the undo stack (coalescing handled by pushOp). */
  const recordOp = useCallback((entry: UndoEntry) => {
    undoRef.current = pushOp(undoRef.current, entry)
  }, [])

  const undo = useCallback(async () => {
    const { state, entry } = undoStack(undoRef.current)
    undoRef.current = state
    if (!entry) return
    await applyEntry(entry, 'undo', { canvas: api.canvas, timestamps: timestampsRef.current })
    refreshCanvas()
  }, [refreshCanvas])

  const redo = useCallback(async () => {
    const { state, entry } = redoStack(undoRef.current)
    undoRef.current = state
    if (!entry) return
    await applyEntry(entry, 'redo', { canvas: api.canvas, timestamps: timestampsRef.current })
    refreshCanvas()
  }, [refreshCanvas])

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

  // ---- `/` picker state. `pickerAnchor` is the viewport-relative SCREEN point
  // where the picker floats (= the intended drop point). Task 11 binds `/` to
  // open it; here we own the mount + pick/jump/close wiring.
  const [pickerAnchor, setPickerAnchor] = useState<{ x: number; y: number } | null>(null)
  const placedNoteIds = useMemo(() => new Set(placedRects.keys()), [placedRects])

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
      // Only the EMPTY surface creates — a double-click over a card begins that
      // card's in-place edit (NoteCard's own dblclick), so skip create there.
      if (index.search({ minX: w.x, minY: w.y, maxX: w.x, maxY: w.y }).length > 0) return
      setCreateAt(w)
    },
    [index],
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
      const hit = index.search({ minX: w.x, minY: w.y, maxX: w.x, maxY: w.y })
      if (hit.length > 0) interactions.onCardPointerDown(e, hit[hit.length - 1] as string)
      else interactions.onSurfacePointerDown(e)
    },
    [index, interactions, placing],
  )

  // ---- Selection-bar verbs (spec §8). `selectedIds` comes from the hook.
  const { selectedIds, clearSelection } = interactions
  const dragOffset = interactions.dragOffset
  const marquee = interactions.marquee

  /** Remove the selected layout rows (notes stay in the feed). Undoable (§13). */
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
