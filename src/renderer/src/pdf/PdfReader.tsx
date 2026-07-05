import { useQueryClient } from '@tanstack/react-query'
import type { PageViewport, PDFPageProxy, RenderTask } from 'pdfjs-dist'
// Modern build (restored): Electron 42's V8 has Map.getOrInsertComputed, so the
// legacy/core-js polyfill build is no longer needed. @see adrs/0044-electron-42-bump.md #152.
import { TextLayer } from 'pdfjs-dist'
import { useEffect, useRef, useState } from 'react'
import { api } from '../lib/api'
import type { SessionSnapshot } from '../persistence/keys'
import { useSessionSnapshot } from '../persistence/useSessionSnapshot'
import { clampZoom, computePdfRender } from './computePdfRender'
import { useExcerptStore } from './excerptState'
// B7: re-enable a visible drag-selection highlight in the text layer (pdf.js's
// bundled CSS sets `.textLayer ::selection { background: transparent }`).
import './pdf-text-layer.css'
import { useExcerptCapture } from './useExcerptCapture'
import { usePdfDocument } from './usePdfDocument'
import { usePdfOpenId } from './usePdfOpenId'

/**
 * Debounce for the per-document zoom write. A ctrl/cmd+wheel gesture fires many
 * wheel events per second; 200 ms coalesces one gesture into a single disk write
 * while committing promptly once the user stops (between the 250 ms scroll and
 * 400 ms draft debounces used elsewhere in v0.7).
 * @see src/renderer/src/App.tsx (feed.scroll.v1 / composer draft debounces)
 */
const ZOOM_PERSIST_DEBOUNCE_MS = 200

/**
 * The right-dock content pane body: renders the current page's canvas + the
 * pdf.js text layer (a DOM overlay of selection-able text — WITHOUT it,
 * `getSelection()` returns empty and excerpt-drag cannot work). Wires
 * selection→excerpt capture; an explicit "Excerpt →" affordance arms placement.
 * Reads the open-pdf id from the persisted `pdf.openDocId` setting so the
 * `PANES` registration stays static (no prop threading).
 * @see docs/specs/v0.6-pdf-slim-slice.md §4, §7
 */
export function PdfReader(): React.JSX.Element {
  const pdfId = usePdfOpenId()
  const { data: doc } = usePdfDocument(pdfId)
  const [page, setPage] = useState<PDFPageProxy | null>(null)
  const [viewport, setViewport] = useState<PageViewport | null>(null)
  // State-backed callback ref (NOT useRef): a ref's `.current` is null on first
  // render and mutating it never re-runs the capture effect, so the mouseup
  // listener would bind to null and never arm (round-2 review C2). State
  // re-renders when the element mounts, so `useExcerptCapture` re-binds.
  const [pageEl, setPageEl] = useState<HTMLDivElement | null>(null)
  // The page-content wrapper (canvas + text layer). Its rect is the true page
  // origin for excerpt coordinates (correct under scroll/zoom). Callback-ref
  // state so the capture effect re-binds once it mounts (mirrors `pageEl`).
  const [contentEl, setContentEl] = useState<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const textLayerRef = useRef<HTMLDivElement>(null)
  // B9: the PDF pane is now one tab of a variable-width right dock, so the fit
  // scale is derived from the live container width (NOT a hardcoded 1.2×). The
  // ResizeObserver below keeps this in sync and re-fits on dock resize.
  const [containerWidth, setContainerWidth] = useState(0)
  // B18: user zoom multiplier over fit-to-width (1 = fit; ctrl/cmd + wheel).
  const [zoom, setZoom] = useState(1)
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

  // Render page 1 (v0.6: single-page; multi-page nav is a queued nit).
  useEffect(() => {
    if (!doc || !canvasRef.current || !textLayerRef.current || containerWidth === 0) return
    let renderTask: RenderTask | null = null
    let cancelled = false
    doc
      .getPage(1)
      .then(async (p) => {
        if (cancelled) return
        // B8/B9/B18: `fitScale × zoom` sizes the CSS display box; `dpr` scales
        // only the backing store for crisp HiDPI output. See computePdfRender.ts
        // for the geometry; the three scales must NOT be conflated.
        const dpr = window.devicePixelRatio || 1
        const unscaled = p.getViewport({ scale: 1 })
        const dims = computePdfRender(containerWidth, unscaled.width, unscaled.height, dpr, zoom)
        const vp = p.getViewport({ scale: dims.scale })
        const canvas = canvasRef.current!
        // Backing store = CSS size × dpr (the actual rendered bitmap)…
        canvas.width = dims.bitmapW
        canvas.height = dims.bitmapH
        // …CSS size stays at the fit-to-width viewport dims (no upscaled blur).
        canvas.style.width = `${dims.cssW}px`
        canvas.style.height = `${dims.cssH}px`
        // pdf.js v6 `RenderParameters` requires `canvas` (the element); the old
        // `canvasContext` field is now an optional backwards-compat alias — see
        // node_modules/pdfjs-dist/types/src/display/api.d.ts (`canvas:
        // HTMLCanvasElement | null`). Passing the element lets pdf.js own the 2D
        // context internally (build/pdf.mjs falls back to `canvas.getContext`).
        // `transform` (the HiDPI dpr matrix, undefined at dpr 1) is the canonical
        // pdf.js HiDPI approach — verified via context7 against the upstream
        // helloworld example (RenderParameters.transform?: any[]).
        renderTask = p.render({ canvas, viewport: vp, transform: dims.transform })
        await renderTask.promise
        const textLayerDiv = textLayerRef.current!
        textLayerDiv.replaceChildren() // idempotent guard against double-invoke
        // The text layer sizes its glyphs from the `--total-scale-factor` CSS var
        // (pdf_viewer.css). pdf.js only auto-derives that var under a
        // `.pdfViewer .page` ancestor, which this slim single-page markup omits —
        // so set it explicitly (user-unit is 1 for normal PDFs). Without it the
        // transparent text spans inherit the app font size and the selectable
        // overlay drifts out of alignment with the rendered canvas.
        textLayerDiv.style.setProperty('--scale-factor', String(vp.scale))
        textLayerDiv.style.setProperty('--total-scale-factor', String(vp.scale))
        const textLayer = new TextLayer({
          textContentSource: p.streamTextContent(),
          container: textLayerDiv,
          viewport: vp,
        })
        await textLayer.render()
        if (cancelled) return
        setPage(p)
        setViewport(vp)
      })
      .catch((err) => {
        // renderTask.cancel() (StrictMode double-invoke/unmount) rejects the
        // awaited render promise with RenderingCancelledException — expected, so
        // swallow it; surface any real render failure instead of a blank canvas.
        if ((err as { name?: string })?.name !== 'RenderingCancelledException')
          console.error('[PdfReader] page render failed', err)
      })
    return () => {
      cancelled = true
      renderTask?.cancel()
    }
  }, [doc, containerWidth, zoom])

  useExcerptCapture({ pdfId: pdfId ?? '', page, viewport, pageEl, contentEl })

  if (!pdfId)
    return <div style={{ padding: 'var(--space-4)', color: 'var(--fg-2)' }}>No PDF open.</div>

  return (
    <div
      ref={setPageEl}
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
      <div
        ref={setContentEl}
        style={{ position: 'relative', margin: '0 auto', display: 'inline-block' }}
      >
        <canvas ref={canvasRef} style={{ display: 'block' }} />
        <div
          ref={textLayerRef}
          className="textLayer"
          style={{ position: 'absolute', inset: 0, overflow: 'hidden' }}
        />
      </div>
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
