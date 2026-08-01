import { useQueryClient } from '@tanstack/react-query'
import { useVirtualizer, type Virtualizer } from '@tanstack/react-virtual'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { api } from '../lib/api'
import type { SessionSnapshot } from '../persistence/keys'
import { useSessionSnapshot } from '../persistence/useSessionSnapshot'
import { clampZoom } from './computePdfRender'
import { useExcerptStore } from './excerptState'
import { type AnchorItem, anchorFromOffset, offsetFromAnchor, type PageAnchor } from './page-anchor'
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
 * Debounce for the per-document zoom write. A ctrl/cmd+wheel gesture fires many
 * wheel events per second; 200 ms coalesces one gesture into a single disk write
 * while committing promptly once the user stops (between the 250 ms scroll and
 * 400 ms draft debounces used elsewhere in v0.7).
 * @see src/renderer/src/App.tsx (feed.scroll.v1 / composer draft debounces)
 */
const ZOOM_PERSIST_DEBOUNCE_MS = 200

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
  // v0.7: the latest debounced-but-unwritten `pdf.view.v1` payload. The debounced
  // persist writer only commits after ZOOM_PERSIST_DEBOUNCE_MS; a doc-swap or a quit
  // (visibilitychange→hidden) within that window would otherwise drop the write. The
  // two flush effects below persist this ref immediately; the persist timer + both
  // flush sites all null it so nothing double-writes. @see spec §Write-through
  const pendingPdfWriteRef = useRef<SessionSnapshot['pdfView'] | null>(null)
  const pending = useExcerptStore((s) => s.pending)
  const arm = useExcerptStore((s) => s.arm)

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
      if (item) anchorRef.current = anchorFromOffset(offset, item)
    },
    [ready, virtualizer],
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
    setZoom(view?.[pdfId ?? '']?.zoom ?? 1)
  }, [doc])

  // v0.7: persist the per-document zoom to `pdf.view.v1` (debounced disk I/O).
  // The boot snapshot cache is boot-initial only and never reflects our own
  // writes, so we ALSO update it live via setQueryData — otherwise the restore
  // effect above would read a stale boot zoom after an in-session A→B→A swap.
  // setQueryData is a synchronous cache write (no refetch under staleTime:∞), so
  // the swap always reads the current value. Skip the no-op echo when zoom already
  // equals the stored (just-restored) value. `view` is read from the latest
  // render's closure (NOT a dep: a view change from our own setQueryData must not
  // reschedule/cancel the pending write); `qc`/`api` are stable.
  // biome-ignore lint/correctness/useExhaustiveDependencies: view is read from closure by design (see above); qc is stable from useQueryClient
  useEffect(() => {
    if (!pdfId) return
    const storedZoom = view?.[pdfId]?.zoom ?? 1
    if (storedZoom === zoom) return // restore echo or unchanged — nothing to write
    const nextView = { ...view, [pdfId]: { ...view?.[pdfId], zoom } } // spread preserves any `page`
    qc.setQueryData<SessionSnapshot>(['session-snapshot'], (old) =>
      old ? { ...old, pdfView: nextView } : old,
    )
    // Hold the pending write so a flush (swap/quit) can commit it; the timer reads
    // the ref so a prior flush that nulled it turns the timer into a no-op (no double
    // write). Only ONE timer is live at a time (this effect's cleanup clears the prior).
    pendingPdfWriteRef.current = nextView
    const id = setTimeout(() => {
      const flushView = pendingPdfWriteRef.current
      if (flushView == null) return
      pendingPdfWriteRef.current = null
      void api.settings.set('pdf.view.v1', flushView)
    }, ZOOM_PERSIST_DEBOUNCE_MS)
    return () => clearTimeout(id)
  }, [zoom, pdfId])

  // v0.7 quit flush: a still-pending debounced zoom must survive Cmd-Q. Mirrors the
  // spec's visibilitychange→hidden last-chance (usePersistedWrite / subscribeDockPersist);
  // the persist timer above may not have fired yet. Mount-once; reads the ref (always live).
  useEffect(() => {
    const flush = () => {
      const flushView = pendingPdfWriteRef.current
      if (!document.hidden || flushView == null) return
      pendingPdfWriteRef.current = null
      void api.settings.set('pdf.view.v1', flushView)
    }
    document.addEventListener('visibilitychange', flush)
    return () => document.removeEventListener('visibilitychange', flush)
  }, [])

  // v0.7 swap flush: on a document swap (or unmount) the persist effect's [zoom,pdfId]
  // cleanup clears the still-pending debounce timer — flush the pending write here first
  // (keyed on pdfId, so this cleanup fires per swap) so a zoom made just before the swap
  // persists instead of dropping.
  // biome-ignore lint/correctness/useExhaustiveDependencies: pdfId is the swap trigger; the ref/api are stable and read at cleanup time
  useEffect(() => {
    return () => {
      const flushView = pendingPdfWriteRef.current
      if (flushView == null) return
      pendingPdfWriteRef.current = null
      void api.settings.set('pdf.view.v1', flushView)
    }
  }, [pdfId])

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
    <div
      ref={setPageEl}
      onScroll={onScroll}
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
            </div>
          ))}
        </div>
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
