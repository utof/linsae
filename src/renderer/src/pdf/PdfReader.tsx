import { useQueryClient } from '@tanstack/react-query'
import { useVirtualizer, type Virtualizer } from '@tanstack/react-virtual'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { PdfLocator } from '../../../shared/types'
import { api } from '../lib/api'
import type { SessionSnapshot } from '../persistence/keys'
import { useSessionSnapshot } from '../persistence/useSessionSnapshot'
import { clampZoom, computePdfRender } from './computePdfRender'
import { useExcerptStore } from './excerptState'
import { PageIndicator, type PageIndicatorHandle } from './PageIndicator'
import { type AnchorItem, anchorFromOffset, offsetFromAnchor, type PageAnchor } from './page-anchor'
import { pdfRectToCssBox } from './pdfRectToCssBox'
import { usePendingJumpStore } from './pendingJumpState'
// B7: re-enable a visible drag-selection highlight in the text layer (pdf.js's
// bundled CSS sets `.textLayer ::selection { background: transparent }`). Imported
// HERE and not in `PdfPage` so the stylesheet is loaded once for the pane, not
// re-evaluated per page component.
import './pdf-text-layer.css'
import { type PageRegistryEntry, PdfPage } from './PdfPage'
import { useExcerptCapture } from './useExcerptCapture'
import { usePdfDocument } from './usePdfDocument'
import { usePdfOpenId } from './usePdfOpenId'
import { estimateHeight, type PageDims, usePdfPageDims } from './usePdfPageDims'

/**
 * Trailing THROTTLE (not a debounce) for the per-document view write.
 *
 * Why a throttle: from v0.8 this write carries the reader POSITION as well as the
 * zoom, and position changes arrive as an unbroken stream of `scroll` events. A
 * debounce re-arms on every event, so a sustained scroll would commit nothing at
 * all until the user came to rest — and a quit mid-gesture would lose the position
 * outright. A trailing throttle commits the live triple every 200 ms of continuous
 * input instead. 200 ms still coalesces one ctrl/cmd+wheel zoom gesture into a
 * single disk write, and sits between the 250 ms scroll and 400 ms draft debounces
 * used elsewhere in v0.7.
 * @see src/renderer/src/thread/ThreadView.tsx (`onGenericScroll` — the same ref-held trailing throttle)
 * @see docs/plans/v0.8-multipage-pdf.md §Task 5.1 (M7)
 */
const VIEW_PERSIST_THROTTLE_MS = 200

/**
 * Gutter between pages, px. Folded into item `start` by the virtualizer's `gap`
 * option, never into `size` — so `estimateSize` stays == the rendered `cssH`
 * (`virtual-core/dist/esm/index.js:648,682-685`). Equivalently: the page wrapper
 * carries no border, padding or shadow.
 * @see docs/specs/v0.8-multipage-pdf.md §4.2
 */
const PAGE_GAP_PX = 12

/**
 * Stand-in dims for the window in which `fallback` is still null. The boot gate
 * keeps the virtualizer disabled then, so `estimateSize` is never consulted for
 * real; `w: 1` (not 0) is what keeps a stray call from returning NaN, since `w`
 * is the divisor in `fitScale` (`usePdfPageDims.ts:54-58`).
 */
const UNMEASURED_DIMS: PageDims = { w: 1, h: 1 }

/**
 * How long the read-back flash stays up, ms.
 *
 * Literally the value the thread already flashes for (`thread/ThreadView.tsx:25`),
 * so the app has ONE "here it is" idiom (spec §5.4). Re-declared rather than
 * imported because that constant is module-local there, and reaching into
 * ThreadView from the PDF pane would couple two unrelated surfaces.
 */
const FLASH_MS = 600

/**
 * Where one document open should land, and whether to flash on arrival.
 *
 * The SAME shape carries both jumps, which is what makes "a pending jump beats the
 * §6 restore" expressible as picking one value rather than as two code paths that
 * must be kept from both running (spec §5.2).
 */
interface RestoreTarget {
  /** 1-based page; clamped to the document length before use. */
  page: number
  /** Within-page position, `0` = top edge. Superseded by `rect` when one is given. */
  fraction: number
  /** PDF user-space rect to land on and flash, or null to land at `fraction` silently. */
  rect: readonly [number, number, number, number] | null
}

/**
 * A live read-back flash: the rect's CSS box **at scale 1**, plus the page's
 * unscaled dims.
 *
 * Why scale 1 and not the rendered scale: the overlay must survive a zoom step
 * while it is up, and a viewport at scale `s` is the scale-1 viewport times `s`
 * (`computePdfRender.ts:82-85`) — so storing the scale-free box and multiplying at
 * render time is exact, and needs no re-derivation when `zoom` changes.
 *
 * It also means the flash does NOT depend on the page registry. A registry entry
 * appears only after that page's text layer has rendered (`PdfPage.tsx:156-158`),
 * which is necessarily *after* the scroll that brings the page into the window — so
 * a registry-sourced viewport would be null exactly when the flash is armed. The
 * reader gets the viewport from `doc.getPage()` instead (memoized by pdf.js), which
 * is available before the page mounts at all.
 */
interface FlashOverlay {
  /** 1-based page the box belongs to. */
  page: number
  /** `pdfRectToCssBox` against that page's scale-1 viewport. */
  box: { left: number; top: number; width: number; height: number }
  /** The page's unscaled dims — what re-derives the live scale. */
  dims: PageDims
}

/**
 * Project a stored flash box onto the page as it is rendered right now.
 * Returns the page's CSS width too, because the overlay reproduces `PdfPage`'s
 * `margin: 0 auto` content box to inherit its horizontal centring exactly.
 * @see FlashOverlay
 */
function flashCssBox(
  flash: FlashOverlay,
  containerWidth: number,
  zoom: number,
): { pageWidth: number; left: number; top: number; width: number; height: number } {
  const { scale, cssW } = computePdfRender(containerWidth, flash.dims.w, flash.dims.h, 1, zoom)
  return {
    pageWidth: cssW,
    left: flash.box.left * scale,
    top: flash.box.top * scale,
    width: flash.box.width * scale,
    height: flash.box.height * scale,
  }
}

/**
 * A locator → the target this open should land on (spec §5.2, §5.3).
 *
 * `page` is optional on `PdfLocator` (`src/shared/types.ts:35`) — a document-level
 * anchor. Such a locator "scrolls to page 1 and does not flash", so it degrades to
 * page 1 with no rect rather than being rejected.
 */
function targetFromLocator(locator: PdfLocator): RestoreTarget {
  return {
    page: locator.page ?? 1,
    fraction: 0,
    rect: locator.page != null ? (locator.rect ?? null) : null,
  }
}

/**
 * The virtualizer's `getItemKey`: key by PAGE NUMBER, not index.
 *
 * Why keyed at all: `PdfPage`'s unmount effect captures `pageNumber` at mount and
 * deregisters with it, which is only correct if an instance can never be recycled
 * for a different page — the React `key` below is `item.key`, so this pins that.
 *
 * Why hoisted to module scope rather than inlined in the options object: it is a
 * dependency of the `getMeasurementOptions` memo, compared by IDENTITY
 * (`virtual-core/dist/esm/index.js:560-568` + `utils.js`'s `memo`, `deps[i] !== dep`).
 * An inline arrow is a fresh identity on every render, which invalidates
 * `getMeasurements` and rebuilds all N measurements on every render — O(500) per
 * scroll frame for a 500-page book, and it silently masks the stale-cache hazard
 * `readAnchorItem` guards.
 */
const pageNumberKey = (index: number): number => index + 1

/**
 * Read a page's CURRENT measurement, forcing a recompute first.
 *
 * Why the `getTotalSize()` call: `virtualizer.measure()` only clears
 * `itemSizeCache`, bumps `itemSizeCacheVersion` and notifies
 * (`virtual-core/dist/esm/index.js:1093-1099`) — it does NOT reassign
 * `measurementsCache`, which is rebuilt only inside the memoized `getMeasurements`
 * (`:589-590`, assignment at `:659` on the `lanes === 1` path). Reading the cache
 * straight after `measure()` therefore returns PRE-CHANGE `start`/`size`, and an
 * offset computed from it is in the old scale — the "throws the reader hundreds of
 * pages away" failure spec §4.5 exists to prevent. `getTotalSize()` calls
 * `getMeasurements()` (`:1037-1039`), which reassigns the cache.
 *
 * Numeric indexing is the ONLY safe way to read that cache: at `lanes === 1` it is a
 * lazy `Proxy` over a sparse array that materializes an item on numeric-index access
 * (`virtual-core/dist/esm/lazy-measurements.js`). Never `.slice()`/spread it.
 *
 * ALL four jumps go through here — zoom re-anchor, boot restore, read-back drain,
 * jump-to-page. Do not inline `measurementsCache[...]` at any call site.
 *
 * @see docs/specs/v0.8-multipage-pdf.md §4.5, §4.6
 */
function readAnchorItem(
  v: Virtualizer<HTMLDivElement, HTMLDivElement>,
  page: number,
): AnchorItem | null {
  v.getTotalSize()
  const m = v.measurementsCache[page - 1]
  return m ? { index: m.index, start: m.start, size: m.size } : null
}

/**
 * Clamp a live anchor into the range `PdfViewV1Schema` accepts, dropping either
 * field rather than emitting one the schema would reject.
 *
 * Why this is not paranoia about arithmetic we control: the WRITE path is
 * unvalidated (`SettingsSetInputSchema.value` is `z.unknown()`,
 * `src/shared/zod-schemas.ts:408`) while the READ path fails WHOLE-RECORD —
 * `PdfViewV1Schema` is a `z.record` read through `safeParseOr(…, {})`
 * (`useSessionSnapshot.ts:35`). So one out-of-range field for one document silently
 * writes fine and then discards EVERY document's view state at the next boot. The
 * `numPages` cap is the reachable case: `measurementsCache` can still describe the
 * outgoing document for a frame after a swap to a shorter one.
 *
 * @see src/shared/zod-schemas.ts (`PdfViewV1Schema` — `page` `.int().positive()`, `pageFraction` `0..1`)
 * @see docs/plans/v0.8-multipage-pdf.md §Task 5.1
 */
function clampPersistedAnchor(
  anchor: PageAnchor,
  numPages: number | undefined,
): { page?: number; pageFraction?: number } {
  const rounded = Math.round(anchor.page)
  const atLeastOne = Math.max(1, rounded)
  const page = Number.isFinite(rounded)
    ? numPages && numPages > 0
      ? Math.min(numPages, atLeastOne)
      : atLeastOne
    : undefined
  const pageFraction = Number.isFinite(anchor.fraction)
    ? Math.min(1, Math.max(0, anchor.fraction))
    : undefined
  // Conditional spread, not `{ page, pageFraction }`: `exactOptionalPropertyTypes`
  // (tsconfig.web.json:16) rejects an explicit `undefined` for an optional field.
  return {
    ...(page !== undefined ? { page } : {}),
    ...(pageFraction !== undefined ? { pageFraction } : {}),
  }
}

/**
 * The right-dock content pane body: a continuous-scroll, virtualized list of
 * every page in the open document.
 *
 * The shell owns three things and delegates the rest to `PdfPage`:
 *
 * 1. **The virtualizer.** `estimateSize` reads the scale-free dims cache
 *    (`usePdfPageDims`) so a 500-page book costs exactly one `getPage` at open;
 *    heights become exact page-by-page as dims resolve, routed through
 *    `resizeItem` because mutating the dims Map does NOT invalidate anything
 *    (spec §4.2.1).
 * 2. **The boot gate.** `containerWidth` is 0 until the `ResizeObserver` fires,
 *    which makes every `estimateSize` return 0 and `getTotalSize()` 0 with
 *    nothing to recompute it afterwards. `enabled: ready` also doubles as the
 *    document-swap reset: `enabled: false` is the only thing that clears
 *    virtual-core's `itemSizeCache` (`index.js:601-605`), so doc A's pixel
 *    heights cannot leak into doc B.
 * 3. **The page registry** — a ref, so N mounted pages mutating it never
 *    re-renders the pane or re-binds the excerpt listener (spec §4.7).
 *
 * Reads the open-pdf id from the persisted `pdf.openDocId` setting so the
 * `PANES` registration stays static (no prop threading).
 *
 * @see docs/specs/v0.8-multipage-pdf.md §4.1, §4.2.1
 * @see docs/specs/v0.6-pdf-slim-slice.md §4, §7
 * @issue utof/linsae#154
 */
export function PdfReader(): React.JSX.Element {
  const pdfId = usePdfOpenId()
  const { data: doc } = usePdfDocument(pdfId)
  // State-backed callback ref (NOT useRef): a ref's `.current` is null on first
  // render and mutating it never re-runs the effects below, so the wheel listener
  // and the virtualizer's `getScrollElement` would bind to null and never recover.
  // State re-renders when the element mounts. (Round-2 review C2, v0.6.)
  const [pageEl, setPageEl] = useState<HTMLDivElement | null>(null)
  // B9: the PDF pane is now one tab of a variable-width right dock, so the fit
  // scale is derived from the live container width (NOT a hardcoded 1.2×). The
  // ResizeObserver below keeps this in sync and re-fits on dock resize.
  const [containerWidth, setContainerWidth] = useState(0)
  // B18: user zoom multiplier over fit-to-width (1 = fit; ctrl/cmd + wheel).
  const [zoom, setZoom] = useState(1)
  // v0.8: what each mounted page publishes for excerpt capture. A REF, not state:
  // N children write to it on every raster, and a state map would re-render the
  // whole pane (and re-bind the capture listener) on every scroll. Read via
  // `.current` at event time. @see docs/specs/v0.8-multipage-pdf.md §4.7
  const registryRef = useRef<Map<number, PageRegistryEntry>>(new Map())
  const { dimsRef, fallback, error: dimsError, ensureDims } = usePdfPageDims(doc)
  const qc = useQueryClient()
  // v0.7: the persisted per-document view map (`pdf.view.v1`). Boot-initial from
  // the session snapshot, but kept LIVE below via setQueryData so an in-session
  // A→B→A swap restores the current zoom, not the stale boot value.
  const view = useSessionSnapshot().data?.pdfView
  const pending = useExcerptStore((s) => s.pending)
  const arm = useExcerptStore((s) => s.arm)
  // v0.8/#155: SUBSCRIBED, not read through `getState()`. A read-back click on the
  // ALREADY-OPEN document changes neither `doc` nor `pdfId`, so the store update is
  // the only trigger that exists for that case.
  const pendingJump = usePendingJumpStore((s) => s.pending)
  // The live read-back flash, or null. State (not a ref) because it is rendered.
  const [flash, setFlash] = useState<FlashOverlay | null>(null)

  /**
   * BOOT GATE (spec §4.2.1). Both halves are load-bearing:
   * `containerWidth > 0` because a 0 width makes every estimate 0, and
   * `fallback != null` because it is what re-closes the gate across a document
   * swap so the previous document's measurements are dropped.
   */
  const ready = containerWidth > 0 && fallback != null

  const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: doc?.numPages ?? 0,
    getScrollElement: () => pageEl,
    estimateSize: (i) =>
      estimateHeight(i + 1, dimsRef.current, fallback ?? UNMEASURED_DIMS, containerWidth, zoom),
    // Key by PAGE NUMBER, not index — see `pageNumberKey`. MUST stay the hoisted
    // constant, never an inline arrow: it is a `getMeasurementOptions` memo dep
    // compared by IDENTITY (`virtual-core/dist/esm/index.js:560-568`, `utils.js`
    // `memo`), so an inline closure invalidates it every render and rebuilds all
    // 500 measurements on every scroll frame — and masks the stale-`measurementsCache`
    // hazard `readAnchorItem` exists to defend against.
    getItemKey: pageNumberKey,
    // Backing-store area scales with zoom², so a resident page at ZOOM_MAX costs
    // ~25× a page at fit. Trade a page of lookahead for the memory. Spec §4.4.
    overscan: zoom > 1 ? 0 : 1,
    gap: PAGE_GAP_PX,
    // `estimateSize` is byte-identical to the rendered `cssH` by construction
    // (both go through `computePdfRender`) and the page wrapper carries no box
    // model, so there is nothing for a DOM measurement to correct — while there
    // IS something for it to break: `PdfPage`'s wrapper is height-auto between
    // mount and first raster (its `css` state is null until dims resolve), so a
    // plain `measureElement` writes that transient height into `itemSizeCache`
    // and collapses the item. This option makes the default `measureElement`
    // return `itemSizeCache.get(key) ?? estimateSize(index)` instead of reading
    // the DOM (`virtual-core/dist/esm/index.js:127-132`), i.e. a provable no-op —
    // which is what spec §4.2.1 means by "measureElement … is not load-bearing".
    // The ref is still passed so `elementsCache` / `indexFromElement` stay wired.
    useCachedMeasurements: true,
    enabled: ready,
  })

  // Identity of the current window. Contiguous by construction (the default
  // `rangeExtractor`), so first:last names it exactly. Used ONLY as the prefetch
  // effect's trigger — re-running it per scroll frame would defeat the coalescing.
  const items = virtualizer.getVirtualItems()
  const windowKey = items.length > 0 ? `${items[0]?.index}:${items[items.length - 1]?.index}` : ''

  // Live reader position (spec §4.6), updated on scroll. A REF, not state: it is read
  // by the re-anchor effect below (and, from Batch 5, the persist writer) at event
  // time; as state it would re-render the whole pane on every scroll frame.
  const anchorRef = useRef<PageAnchor | null>(null)
  /** The page indicator's imperative handle — see `setAnchor` for why it is one. */
  const indicatorRef = useRef<PageIndicatorHandle>(null)
  /**
   * A read-back jump taken out of the store but not yet performed — tagged with the
   * document it is for, since it is routinely consumed while `pdf.openDocId` is
   * still being written and the reader is showing something else.
   */
  const jumpTargetRef = useRef<{ pdfId: string; target: RestoreTarget } | null>(null)
  /** This open's persisted position (spec §6). A jump above beats it. */
  const restoreTargetRef = useRef<RestoreTarget | null>(null)
  /**
   * Supersede/abort token for the async restore below. Deliberately NOT the
   * effect's cleanup: the effect re-runs when `pendingJump` clears itself, and a
   * cleanup-driven abort would cancel the very jump that clear was caused by.
   * Bumped only when a restore actually STARTS, and on every document swap.
   */
  const restoreRunRef = useRef(0)
  // The single live persist timer (v0.8). A REF, not state, and ONE for both the
  // zoom and the position path: the two must coalesce into one write, and the timer
  // must survive the renders that `setQueryData` triggers.
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  // The trailing read. Kept pointing at the LATEST render's `commitView` (effect
  // below) so a timer armed at the start of a gesture commits the values at the END
  // of it — the "trailing read of the live value" half of the throttle.
  const commitRef = useRef<() => void>(() => {})

  /**
   * Arm the trailing throttle. `if (…) return` — NOT `clearTimeout` + re-arm — is
   * the whole difference between a throttle and a debounce: re-arming on every
   * `scroll` event is exactly the M7 bug (a sustained scroll never commits).
   * @see src/renderer/src/thread/ThreadView.tsx (`onGenericScroll`)
   */
  const schedulePersist = useCallback(() => {
    if (persistTimerRef.current) return
    persistTimerRef.current = setTimeout(() => {
      persistTimerRef.current = undefined
      commitRef.current()
    }, VIEW_PERSIST_THROTTLE_MS)
  }, [])

  /**
   * Commit a throttled-but-unfired write NOW — quit (visibilitychange→hidden), doc
   * swap, or unmount. Stable (`[]` deps, refs only) so the mount-once quit listener
   * below never rebinds. Reads `commitRef.current`, which at a passive-cleanup is
   * still the OUTGOING document's closure (React runs every cleanup in a commit
   * before any setup), so a swap flush persists the document being left.
   */
  const flushPersist = useCallback(() => {
    if (!persistTimerRef.current) return
    clearTimeout(persistTimerRef.current)
    persistTimerRef.current = undefined
    commitRef.current()
  }, [])

  /**
   * Adopt a position as the live reader anchor AND mirror it into the page
   * indicator. The SINGLE place `anchorRef` is assigned a value, so the two can
   * never drift apart.
   *
   * Why the indicator is pushed to rather than reading state: `anchorRef` is a ref
   * deliberately — it is written on every scroll frame precisely so a scroll does
   * not re-render this pane. The indicator must RENDER that number, so promoting the
   * anchor to state here would re-render every windowed page per frame and undo that
   * decision. Pushing through the handle re-renders one leaf instead, and only when
   * the integer page changes (`PageIndicator` bails out on an unchanged value).
   */
  const setAnchor = useCallback((a: PageAnchor) => {
    anchorRef.current = a
    indicatorRef.current?.report(a.page)
  }, [])

  /**
   * Jump to a page from the indicator (plan §Task 6.1).
   *
   * The clamp is load-bearing, not hygiene: an out-of-range page indexes
   * `measurementsCache` outside `count`, `readAnchorItem` returns null, and the jump
   * SILENTLY does nothing — typing 9999 would read as a broken control rather than
   * "the document ends at 500".
   *
   * Unlike the restore below this needs no `ensureDims`/`measure()` round-trip,
   * because it lands at `fraction: 0`: `offsetFromAnchor(0, item)` is `item.start`,
   * which never consults the TARGET page's own height. `readAnchorItem`'s own
   * `getTotalSize()` is still what makes `item.start` current.
   *
   * `schedulePersist` is explicit rather than left to the `scroll` event the
   * programmatic scroll will emit: the write must be armed whether or not that echo
   * arrives (it does not under happy-dom), exactly as the zoom path is.
   */
  const jumpToPage = useCallback(
    (page: number) => {
      if (!doc) return
      const target = Math.min(Math.max(1, Math.round(page)), Math.max(1, doc.numPages))
      const item = readAnchorItem(virtualizer, target)
      if (!item) return
      virtualizer.scrollToOffset(offsetFromAnchor(0, item), { align: 'start' })
      setAnchor({ page: target, fraction: 0 })
      schedulePersist()
    },
    [doc, virtualizer, setAnchor, schedulePersist],
  )

  // Wired as React's `onScroll` prop, NOT a native listener. `scroll` is one of
  // React's non-delegated events (`react-dom-client.development.js:27450-27454`), so
  // React attaches it directly to THIS element rather than to the root — it fires for
  // exactly this scroller and needs no effect/cleanup/null-pageEl dance. The wheel
  // listener below is native for a reason that does not carry over: React registers
  // `wheel` passively so its `preventDefault()` is a no-op, whereas `scroll` is not
  // cancelable and nothing here calls `preventDefault`. `e.currentTarget` (not the
  // nullable `pageEl` state) is what makes the element non-null under `strict`.
  const onScroll = useCallback(
    (e: React.UIEvent<HTMLDivElement>) => {
      if (!ready) return
      const offset = e.currentTarget.scrollTop
      const item = virtualizer.getVirtualItemForOffset(offset)
      if (item) setAnchor(anchorFromOffset(offset, item))
      // v0.8/M7: the position write is driven from HERE, not from a `useEffect` dep.
      // `anchorRef` is deliberately a ref (a scroll must not re-render the pane), so
      // there is no render for a dep array to observe — the scroll event itself is
      // the only trigger that exists. Same shape as `ThreadView.onGenericScroll`.
      schedulePersist()
    },
    [ready, virtualizer, schedulePersist, setAnchor],
  )

  /**
   * Zoom / dock-width change: capture BEFORE, measure, re-scroll (spec §4.5).
   *
   * `measure()` is unconditional and precedes the null-anchor bail because it is
   * load-bearing for the LIST, not just the anchor: `getMeasurements` is memoized on
   * `[getMeasurementOptions(), itemSizeCacheVersion]` and `estimateSize` is in
   * neither (`virtual-core/dist/esm/index.js:560-588`), so without the version bump
   * every page keeps its old-zoom `start`.
   *
   * `useLayoutEffect`, not `useEffect`: the re-scroll must land in the same commit as
   * the new item positions, or the user sees one frame at the old offset in the new
   * scale.
   *
   * It runs on mount too, and the mount path was probe-verified rather than assumed:
   * the runs are `{ready: false, w: 0}`, `{ready: false, w: 900}`, then the scale
   * change itself. Gate-open never triggers a run, because `ready` flips on
   * `fallback` resolving and `fallback` is not a dep. So the `!anchor` bail is NOT
   * for the boot path; it is for the case that genuinely reaches it — a dock resize
   * before the user has scrolled at all, where `measure()` must still run but there
   * is no position to restore.
   *
   * `align: 'start'` is always explicit — the `'auto'` default silently rewrites the
   * offset to an `'end'` alignment once the target is past the viewport (`:941-945`).
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: zoom/containerWidth are the SCALE-CHANGE trigger — `ready` is read only as an early-out (adding it would fire a pointless measure+bail at gate-open) and `virtualizer` is a stable instance from useState (`react-virtual/dist/esm/index.js:79`); `anchorRef` is a ref, read at effect time by design
  useLayoutEffect(() => {
    if (!ready) return
    const anchor = anchorRef.current
    virtualizer.measure()
    if (!anchor) return
    const item = readAnchorItem(virtualizer, anchor.page)
    if (item)
      virtualizer.scrollToOffset(offsetFromAnchor(anchor.fraction, item), { align: 'start' })
  }, [zoom, containerWidth])

  // Measure the scroll container and re-measure on resize (B9, fit-to-width).
  // `clientWidth` excludes the border and the reserved scrollbar gutter, so the
  // fit width is stable whether or not the vertical bar shows (B17).
  useEffect(() => {
    if (!pageEl) return
    const measure = () => setContainerWidth(pageEl.clientWidth)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(pageEl)
    return () => ro.disconnect()
  }, [pageEl])

  /**
   * Resolve real dims for the pages currently in the window, then correct their
   * heights. All three of spec §4.2's rules are here, not just the coalescing:
   *
   * - **Skip while flinging** (`isScrolling`) — a fast scroll through 500 pages
   *   must not issue hundreds of `getPage` worker round-trips.
   * - **Coalesce** — `ensureDims` returns dims only when NEWLY learned, so an
   *   already-known page produces no second request and no redundant resize.
   * - **Drop stale results** — a page that scrolled out of the window while its
   *   `getPage` was in flight is no longer ours to resize.
   *
   * `resizeItem` (not a dims-Map mutation) is the invalidation path: `getMeasurements`
   * is memoized on `[getMeasurementOptions(), itemSizeCacheVersion]` and `estimateSize`
   * is not among its deps, so a new closure alone changes nothing (spec §4.2.1).
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: `windowKey` is the window-identity TRIGGER (the effect reads the live `getVirtualItems()`); `virtualizer` is a stable instance from useState
  useEffect(() => {
    if (!ready || virtualizer.isScrolling) return
    let cancelled = false
    for (const item of items) {
      const index = item.index
      void ensureDims(index + 1).then((d) => {
        if (cancelled || !d) return
        if (!virtualizer.getVirtualItems().some((v) => v.index === index)) return
        virtualizer.resizeItem(
          index,
          estimateHeight(
            index + 1,
            dimsRef.current,
            fallback ?? UNMEASURED_DIMS,
            containerWidth,
            zoom,
          ),
        )
      })
    }
    return () => {
      cancelled = true
    }
  }, [
    ready,
    virtualizer,
    virtualizer.isScrolling,
    windowKey,
    ensureDims,
    dimsRef,
    fallback,
    containerWidth,
    zoom,
  ])

  // B18/v0.7: on a document swap, RESTORE that document's persisted zoom (fit=1
  // when unseen). `doc` is the swap TRIGGER; `view`/`pdfId` are read to pick the
  // restore value but MUST NOT be deps — only a doc swap re-restores, and `view`
  // (kept live below) changing on our own write must not re-fire this.
  // biome-ignore lint/correctness/useExhaustiveDependencies: doc is the restore-on-swap trigger; view/pdfId are read but excluded so only a doc swap (not our own live-cache write) re-restores
  useEffect(() => {
    const stored = view?.[pdfId ?? '']
    setZoom(stored?.zoom ?? 1)
    // v0.8: the anchor describes the OUTGOING document. Left in place it would be
    // written back under the INCOMING document's id on its first persist (before the
    // user has scrolled it), i.e. doc B silently inheriting doc A's page. The swap
    // flush runs in the cleanup phase, ahead of this setup, so A's own last write
    // still sees A's anchor.
    anchorRef.current = null
    // …and abort a restore still in flight for the OUTGOING document, so its
    // `scrollToOffset` can't land on the incoming one.
    restoreRunRef.current += 1
    setFlash(null)
    // v0.8 §6: arm THIS open's position restore. Only `page` is required —
    // `pageFraction` was added in v0.8, so a v0.7-written entry restores to the top
    // of its page rather than being ignored.
    restoreTargetRef.current =
      stored?.page !== undefined
        ? { page: stored.page, fraction: stored.pageFraction ?? 0, rect: null }
        : null
    // A jump queued for a DIFFERENT document than the one now open can never be
    // honoured; drop it rather than let it fire if that document is reopened later.
    if (jumpTargetRef.current && jumpTargetRef.current.pdfId !== pdfId) jumpTargetRef.current = null
  }, [doc])

  /**
   * Take a matching read-back jump out of the store (spec §5.2).
   *
   * Separate from the restore effect below, and declared AFTER the swap effect, for
   * two ordering reasons. (1) The swap effect arms the persisted target; this one
   * runs later in the same commit, so a jump always overwrites — never the reverse.
   * (2) `consumePendingJump` mutates the store, which re-renders; keeping the
   * consume out of the effect that owns the async scroll means that re-render cannot
   * interrupt work already in flight.
   *
   * It runs BEFORE the gate opens on purpose: the jump is parked in
   * `jumpTargetRef` and performed once `ready` is true, so a jump into a
   * not-yet-loaded document is not lost.
   */
  useEffect(() => {
    if (!pendingJump || pendingJump.pdfId !== pdfId || !pdfId) return
    const jump = usePendingJumpStore.getState().consumePendingJump()
    if (jump) jumpTargetRef.current = { pdfId: jump.pdfId, target: targetFromLocator(jump.locator) }
  }, [pendingJump, pdfId])

  /**
   * Perform this open's ONE scroll: a read-back jump if one is queued, otherwise the
   * persisted position (spec §5.2 — "a pending jump wins"; §6 — restore).
   *
   * Precedence is a value choice, not a race: both candidates are read here and one
   * is picked, so the persisted restore cannot run "as well" and then be fought by
   * the jump.
   *
   * The targets are cleared on SUCCESS, not on entry. `ready` is computed at render
   * time, and on the commit where `doc` changes it still describes the OUTGOING
   * document — `usePdfPageDims` re-nulls `fallback` in the same commit, one render
   * too late for this effect to see. So the first attempt after a swap runs against
   * a virtualizer that is about to be disabled, `readAnchorItem` returns null, and
   * the target must survive for the attempt that follows once the gate genuinely
   * reopens. Clearing on entry instead silently drops every swap-time restore.
   *
   * Ordering against dims: `ensureDims(page)` first, because `fraction × size` only
   * means anything once `size` is the TARGET page's height rather than page 1's
   * estimate. `measure()` then bumps `itemSizeCacheVersion` so those dims actually
   * reach `getMeasurements` (a dims-Map mutation alone invalidates nothing — spec
   * §4.2.1), and `readAnchorItem` forces the recompute before reading. This is the
   * same recompute-then-read discipline as the zoom re-anchor above; a raw
   * `measurementsCache` read here would be the stale-cache bug in a second place.
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: `pendingJump` is a TRIGGER for the same-document case (nothing else changes then), not a value the body reads — the jump is read from `jumpTargetRef`; `virtualizer` is a stable instance from useState
  useEffect(() => {
    if (!ready || !doc) return
    const jump = jumpTargetRef.current?.pdfId === pdfId ? jumpTargetRef.current.target : null
    const target = jump ?? restoreTargetRef.current
    if (!target) return

    const run = ++restoreRunRef.current
    void (async () => {
      const page = Math.min(Math.max(1, Math.round(target.page)), Math.max(1, doc.numPages))
      await ensureDims(page)
      if (restoreRunRef.current !== run) return

      let fraction = target.fraction
      let overlay: FlashOverlay | null = null
      if (target.rect) {
        // `getPage` is memoized by pdf.js, and resolves whether or not the page is
        // windowed — which is the point: the page the flash targets is BY DEFINITION
        // not mounted yet at the moment the jump is armed.
        const p = await doc.getPage(page)
        if (restoreRunRef.current !== run) return
        const vp = p.getViewport({ scale: 1 })
        // pdf.js types `convertToViewportPoint` as `any[]` (`page_viewport.d.ts:127`);
        // cast to the helper's own param type, the idiom at `useExcerptCapture.ts:96-98`.
        const box = pdfRectToCssBox(
          vp as unknown as Parameters<typeof pdfRectToCssBox>[0],
          target.rect,
        )
        // Zero AREA, not "the box is zero": `pdfRectToCssBox` maps a degenerate
        // `[0,0,0,0]` through the viewport's y-flip, so its `top` is the page HEIGHT,
        // not 0. Testing the whole box would never fire, and the fraction derived from
        // that `top` would park the reader at the page's bottom edge. Such a rect
        // scrolls to the page and skips the flash (spec §5.3) — it is what
        // `clientRectsToPdfRect.ts:16` returns for an empty rect list, which capture
        // writes unconditionally (`useExcerptCapture.ts:79-84`).
        if (box.width > 0 && box.height > 0 && vp.height > 0) {
          fraction = Math.min(1, Math.max(0, box.top / vp.height))
          overlay = { page, box, dims: { w: vp.width, h: vp.height } }
        }
      }

      virtualizer.measure()
      const item = readAnchorItem(virtualizer, page)
      // Superseded, or the gate closed under us — leave the target armed to retry.
      if (restoreRunRef.current !== run || !item) return
      if (jump) jumpTargetRef.current = null
      restoreTargetRef.current = null
      virtualizer.scrollToOffset(offsetFromAnchor(fraction, item), { align: 'start' })
      // Adopt the landed position as the live anchor. Both halves of "don't fight the
      // writer" hang off this line: after a §6 restore the next commit's triple is
      // byte-equal to what is stored, so the echo guard suppresses the write
      // entirely; after a jump the writer persists where the user now IS. Leaving it
      // null instead would keep the pre-jump page as the thing that gets persisted.
      setAnchor({ page, fraction })
      setFlash(overlay)
    })()
  }, [ready, doc, pdfId, pendingJump, ensureDims, virtualizer, setAnchor])

  // Fade the flash after FLASH_MS. Keyed on the overlay object, so a second jump
  // while one is up restarts the clock instead of inheriting the old timer.
  useEffect(() => {
    if (!flash) return
    const id = setTimeout(() => setFlash(null), FLASH_MS)
    return () => clearTimeout(id)
  }, [flash])

  /**
   * THE writer — the single place `pdf.view.v1` is produced (v0.7 zoom, v0.8
   * position). Called only on the throttle's trailing edge or from a flush.
   *
   * Re-created every render on purpose: it is reached through `commitRef`, so what
   * it closes over IS the trailing read — the live `zoom`/`view`/`doc` at fire time,
   * not the values that happened to be current when the timer was armed.
   *
   * Three things it must keep doing, all of them v0.7 behaviour:
   * - **Live cache write.** The boot snapshot never reflects our own writes, so the
   *   restore effect above would read a stale boot zoom after an A→B→A swap without
   *   `setQueryData` (a synchronous write; no refetch under `staleTime: ∞`).
   * - **Merge, never clobber.** `{...view}` keeps every other document's entry.
   * - **Echo suppression.** A just-restored value must not be written back. The
   *   guard now covers the whole triple, not just zoom (a scroll at constant zoom is
   *   the one write v0.8 exists for — M7); `?? 1` keeps an unseen document at fit
   *   from writing on mount, exactly as the v0.7 `storedZoom` default did.
   *
   * `{...stored}` before the overrides is what preserves a persisted `page` while
   * the anchor is still null (the boot window before the user scrolls) — without it
   * the first zoom of a session would erase the restored position.
   */
  const commitView = () => {
    if (!pdfId) return
    const stored = view?.[pdfId]
    const anchor = anchorRef.current
    const pos = anchor ? clampPersistedAnchor(anchor, doc?.numPages) : {}
    // Conditional spread — `exactOptionalPropertyTypes` (tsconfig.web.json:16)
    // rejects an explicit `undefined`; the repo idiom (useExcerptCapture.ts:88-89).
    const next = {
      ...stored,
      zoom,
      ...(pos.page !== undefined ? { page: pos.page } : {}),
      ...(pos.pageFraction !== undefined ? { pageFraction: pos.pageFraction } : {}),
    }
    if (
      (stored?.zoom ?? 1) === next.zoom &&
      stored?.page === next.page &&
      stored?.pageFraction === next.pageFraction
    )
      return
    const nextView = { ...view, [pdfId]: next }
    qc.setQueryData<SessionSnapshot>(['session-snapshot'], (old) =>
      old ? { ...old, pdfView: nextView } : old,
    )
    void api.settings.set('pdf.view.v1', nextView)
  }

  // Point the trailing read at this render's closure. NO dep array by design: every
  // render must refresh it. React runs every passive cleanup in a commit before any
  // setup, so the swap flush below still sees the OUTGOING document's closure.
  useEffect(() => {
    commitRef.current = commitView
  })

  // Zoom path into the same throttle. A ctrl/cmd+wheel zoom `preventDefault()`s and
  // therefore fires no `scroll`, so it cannot ride `onScroll` — but it must share the
  // ONE timer, or a zoom-then-scroll would produce two writes for one gesture.
  // biome-ignore lint/correctness/useExhaustiveDependencies: zoom/pdfId are the TRIGGER, not values the body reads — the trailing read happens later, through commitRef. Dropping them (biome's "unnecessary" fix) would arm the throttle once at mount and never again on a zoom
  useEffect(() => {
    schedulePersist()
  }, [zoom, pdfId, schedulePersist])

  // v0.7 quit flush: a still-pending write must survive Cmd-Q. Mirrors the spec's
  // visibilitychange→hidden last-chance (usePersistedWrite / subscribeDockPersist);
  // the throttle timer may not have fired yet. `flushPersist` is stable, so this
  // listener binds once.
  useEffect(() => {
    const flush = () => {
      if (document.hidden) flushPersist()
    }
    document.addEventListener('visibilitychange', flush)
    return () => document.removeEventListener('visibilitychange', flush)
  }, [flushPersist])

  // v0.7 swap flush: on a document swap (or unmount) a still-armed timer would be
  // left describing a document that is no longer open — commit it first, keyed on
  // pdfId so this cleanup fires per swap.
  // biome-ignore lint/correctness/useExhaustiveDependencies: pdfId is the swap TRIGGER — the cleanup is the whole point, so removing it would reduce this to an unmount-only flush and drop every pre-swap write
  useEffect(() => {
    return () => flushPersist()
  }, [pdfId, flushPersist])

  // B18: ctrl/cmd + wheel zooms; plain wheel scrolls as normal. A NATIVE,
  // non-passive listener is required — React registers `onWheel` as a passive
  // root listener, so its `preventDefault()` is a no-op. Verified via context7
  // (react.dev common-components: native listeners attach via a ref with
  // addEventListener(type, listener, options)).
  useEffect(() => {
    if (!pageEl) return
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault() // stop the page/app from also scroll-zooming
      const ZOOM_STEP = 1.1
      setZoom((z) => clampZoom(z * (e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP)))
    }
    pageEl.addEventListener('wheel', onWheel, { passive: false })
    return () => pageEl.removeEventListener('wheel', onWheel)
  }, [pageEl])

  // Excerpt capture resolves the anchor page from the selection itself and reads
  // `registryRef.current` at event time, so ONE listener on the scroll container
  // serves every windowed page and no page mount/unmount re-binds it (spec §4.7).
  useExcerptCapture({ pdfId: pdfId ?? '', registryRef, scrollEl: pageEl })

  // Re-derived every render rather than stored: the flash must follow a zoom step
  // taken while it is up, and this is the only place `zoom`/`containerWidth` are live.
  const flashCss = flash && containerWidth > 0 ? flashCssBox(flash, containerWidth, zoom) : null

  if (!pdfId)
    return <div style={{ padding: 'var(--space-4)', color: 'var(--fg-2)' }}>No PDF open.</div>

  // #183: pdf.js resolves `getDocument()` before validating the page tree, so a
  // document whose page 1 is corrupt opens "successfully" and only fails when its
  // dims are probed. The gate stays shut on that path BY DESIGN (`fallback` must
  // stay null), so without this the user gets a blank pane forever.
  if (dimsError)
    return (
      <div style={{ padding: 'var(--space-4)', color: 'var(--fg-2)' }}>
        This PDF could not be read. {dimsError}
      </div>
    )

  return (
    // A `div` receives PageUp / PageDown / Home / End only while FOCUSED, and this
    // root carried no `tabIndex` until now — so those keys did nothing in the reader.
    // `tabIndex={0}` is the whole fix: the browser then pages a focused scrollable
    // box natively, which is strictly better than re-implementing paging (it already
    // knows the viewport height, the overscroll behaviour and the platform's
    // smooth-scroll setting). No focus ring is added: Chromium paints the UA outline
    // only on `:focus-visible`, i.e. keyboard focus — exactly when the user needs to
    // know the keys are live — and never on the click-to-focus that selecting text
    // performs. (Plan §Task 6.1.)
    //
    // No `role="region"` to go with it: biome's `useSemanticElements` correctly says
    // that role belongs on a `<section>`, and this element cannot become one — it is
    // typed `HTMLDivElement` through `useVirtualizer<HTMLDivElement, HTMLDivElement>`
    // and `useExcerptCapture`'s `scrollEl`. A bare `aria-label` without a role is not
    // exposed by AT, so it would be decoration.
    <div
      ref={setPageEl}
      onScroll={onScroll}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable box MUST be keyboard-reachable (WCAG 2.1.1 / SC 2.1.1 scrollable-region technique), and the alternative — hand-implementing PageUp/PageDown/Home/End — is what plan §Task 6.1 forbids
      tabIndex={0}
      style={{
        position: 'relative',
        width: '100%',
        height: '100%',
        // B17: reserve the vertical-scrollbar gutter so `clientWidth` is stable
        // (the page is fit against it whether or not the bar shows); clip any
        // sub-pixel horizontal remainder at fit, and only allow horizontal
        // scrolling once zoomed in past fit.
        scrollbarGutter: 'stable',
        overflowY: 'auto',
        overflowX: zoom > 1 ? 'auto' : 'hidden',
        background: 'var(--bg-0)',
      }}
    >
      {ready && doc && (
        // Spacer: its height is the exact total content size, so the scroller's
        // native `scrollHeight` matches the virtual document. Mirrors `Feed.tsx:973-981`.
        <div style={{ height: virtualizer.getTotalSize(), width: '100%', position: 'relative' }}>
          {items.map((item) => (
            // The positioned wrapper is OUTSIDE `PdfPage`: the page owns
            // `data-index` / `data-page-number` / `measureRef` / its own height, and
            // must stay free of box model so `gap` is the only inter-page space.
            <div
              key={item.key}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                transform: `translateY(${item.start}px)`,
              }}
            >
              <PdfPage
                doc={doc}
                pageNumber={item.index + 1}
                containerWidth={containerWidth}
                zoom={zoom}
                registryRef={registryRef}
                measureRef={virtualizer.measureElement}
              />
              {flashCss && flash?.page === item.index + 1 && (
                // Read-back flash (spec §5.4). A SIBLING of the page, not a child:
                // `PdfPage` is outside this task's file set, and the reader can
                // reproduce the page's content box exactly — the two nested divs
                // below mirror `PdfPage.tsx:212-218`, so `margin: 0 auto` does the
                // horizontal centring identically instead of it being re-derived
                // here (and getting the zoom > 1 overflow case wrong).
                <div
                  data-testid="pdf-readback-flash"
                  style={{ position: 'absolute', top: 0, left: 0, width: '100%' }}
                >
                  <div
                    style={{ position: 'relative', margin: '0 auto', width: flashCss.pageWidth }}
                  >
                    <div
                      style={{
                        position: 'absolute',
                        left: flashCss.left,
                        top: flashCss.top,
                        width: flashCss.width,
                        height: flashCss.height,
                        // Highlighter, not a cover: `multiply` over the light tint
                        // leaves the glyphs underneath legible, where an opaque fill
                        // would hide the very text the flash is pointing at. Outline
                        // matches the thread's flash idiom (`thread/Rail.tsx:195`).
                        background: 'var(--accent-tint)',
                        mixBlendMode: 'multiply',
                        outline: '2px solid var(--accent)',
                        borderRadius: 'var(--r-1)',
                        // Never intercept a drag: excerpt capture reads the SELECTION,
                        // and a live overlay across the text would break re-capture.
                        pointerEvents: 'none',
                      }}
                    />
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      {ready && doc && (
        // AFTER the spacer, never before it: the spacer must stay this scroller's
        // first element child — that is what makes native `scrollHeight` the virtual
        // document's height (and what `tests/pdf-layout.ts`'s `installScrollHeight`
        // reads). BEFORE the excerpt bar so that bar, a later positioned sibling,
        // paints over the pill on the frames where both are up.
        //
        // `key={pdfId}` is defence in depth, NOT what resets the page today — and the
        // swap test does not bite on removing it (mutation-checked). What resets it is
        // the `ready` gate above: `usePdfPageDims` re-nulls `fallback` on every doc
        // change, so this whole subtree unmounts across a swap and the indicator's
        // page state goes with it. The key states the invariant locally — this
        // component's identity IS the document — so that showing the indicator during
        // a load (i.e. outside the gate) cannot silently reintroduce "doc B opens
        // claiming doc A's page".
        <PageIndicator key={pdfId} ref={indicatorRef} numPages={doc.numPages} onJump={jumpToPage} />
      )}
      {pending && (
        <div
          style={{
            position: 'sticky',
            bottom: 0,
            display: 'flex',
            justifyContent: 'flex-end',
            padding: 'var(--space-2)',
            background: 'var(--bg-2)',
            borderTop: '1px solid var(--border-0)',
          }}
        >
          <button type="button" onClick={() => arm()} style={{ fontSize: 'var(--t-13)' }}>
            Excerpt → place on canvas
          </button>
        </div>
      )}
    </div>
  )
}
