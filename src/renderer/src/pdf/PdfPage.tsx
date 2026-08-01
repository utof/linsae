import type { PageViewport, PDFDocumentProxy, PDFPageProxy, RenderTask } from 'pdfjs-dist'
// Modern build (restored): Electron 42's V8 has Map.getOrInsertComputed, so the
// legacy/core-js polyfill build is no longer needed. @see adrs/0044-electron-42-bump.md #152.
import { TextLayer } from 'pdfjs-dist'
import { useEffect, useRef, useState } from 'react'
import { capBitmapPixels } from './capBitmapPixels'
import { computePdfRender } from './computePdfRender'

/**
 * What a mounted `PdfPage` publishes for excerpt capture: the anchor page's own
 * proxy, the viewport its text layer was laid out against, and the content box
 * whose top-left is that page's coordinate origin.
 *
 * Why it is produced HERE rather than declared on the reader: `PdfPage` is the
 * only writer. The reader owns the `Map` (a ref, so N children mutating it never
 * re-binds the `mouseup` listener) and reads `.current` at event time.
 *
 * @see docs/specs/v0.8-multipage-pdf.md §4.7 (the excerpt seam)
 */
export interface PageRegistryEntry {
  page: PDFPageProxy
  viewport: PageViewport
  contentEl: HTMLElement
}

interface PdfPageProps {
  doc: PDFDocumentProxy
  /** 1-based page number, as pdf.js counts them. */
  pageNumber: number
  /** The scroll container's `clientWidth` in CSS px; 0 before it is measured. */
  containerWidth: number
  /** User zoom multiplier over fit-to-width (the reader clamps it). */
  zoom: number
  /** The reader's page registry — this page adds itself on ready, removes on unmount. */
  registryRef: React.RefObject<Map<number, PageRegistryEntry>>
  /**
   * `virtualizer.measureElement`, composed with nothing else. It MUST be the
   * wrapper's `ref` or `indexFromElement` never reads `data-index`
   * (`virtual-core/index.js:802-825`).
   */
  measureRef: (node: HTMLDivElement | null) => void
}

/**
 * One page of the continuous-scroll reader: rasterizes into a `<canvas>` and
 * overlays pdf.js's selectable `TextLayer`, then publishes itself to the page
 * registry so excerpt capture can resolve coordinates against *this* page.
 *
 * The lifecycle is deliberately split across two effects, because a **scale
 * change** and an **unmount** must do different things:
 *
 * - Scale change (`containerWidth` / `zoom`) cancels the in-flight render and
 *   re-rasterizes into the SAME canvas. Assigning any value to `canvas.width` —
 *   even the value it already holds — clears the bitmap per the HTML spec, so a
 *   zero-then-resize would flash white across every resident page on the
 *   reader's most-used interaction (spec §4.3).
 * - Unmount tears down in the order pdf.js rewards: cancel → cancel → cleanup →
 *   release the bitmap → deregister (spec §4.3 steps 8-10).
 *
 * @see docs/specs/v0.8-multipage-pdf.md §4.3
 * @issue utof/linsae#154
 */
export function PdfPage({
  doc,
  pageNumber,
  containerWidth,
  zoom,
  registryRef,
  measureRef,
}: PdfPageProps): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const textLayerElRef = useRef<HTMLDivElement>(null)
  // A plain ref, NOT the `setContentEl` state the v0.6 reader used
  // (`PdfReader.tsx:50`). That state existed so `useExcerptCapture` could re-bind
  // its listener once the element mounted; v0.8 routes the element through the
  // registry instead, which is read at event time. State here would additionally
  // re-run the render effect on mount (null → element) and rasterize twice.
  const contentRef = useRef<HTMLDivElement>(null)
  const renderTaskRef = useRef<RenderTask | null>(null)
  const textLayerRef = useRef<TextLayer | null>(null)
  const pageRef = useRef<PDFPageProxy | null>(null)
  // The rendered CSS box. Null until the page's dims are known; the wrapper is
  // height-auto until then and the reader's `estimateSize` carries the layout.
  const [css, setCss] = useState<{ w: number; h: number } | null>(null)

  useEffect(() => {
    if (containerWidth <= 0) return
    let cancelled = false
    doc
      .getPage(pageNumber)
      .then(async (p) => {
        if (cancelled) return
        pageRef.current = p
        // B8/B9/B18: `fitScale × zoom` sizes the CSS display box; `dpr` scales
        // only the backing store for crisp HiDPI output. See computePdfRender.ts
        // for the geometry; the three scales must NOT be conflated.
        const dpr = window.devicePixelRatio || 1
        const unscaled = p.getViewport({ scale: 1 })
        // `w` is the DIVISOR in `fitScale = containerWidth / w`, so w === 0 makes
        // cssW `floor(0 * Infinity)` = NaN, capBitmapPixels propagates it (its
        // `area > 0` test is false for NaN), and `canvas.width = NaN` coerces to 0
        // per WebIDL — a silently blank page with nothing in the console. `h` is
        // only a multiplicand and degrades to a 0-height box, which is why the
        // guard is asymmetric here exactly as in `usePdfPageDims.ts:38-42`.
        if (!(unscaled.width > 0)) {
          console.error('[PdfPage] page reported a non-positive width', pageNumber, unscaled.width)
          return
        }
        const dims = computePdfRender(containerWidth, unscaled.width, unscaled.height, dpr, zoom)
        const vp = p.getViewport({ scale: dims.scale })
        const canvas = canvasRef.current
        const textLayerDiv = textLayerElRef.current
        const contentEl = contentRef.current
        if (!canvas || !textLayerDiv || !contentEl) return
        setCss({ w: dims.cssW, h: dims.cssH })
        // v0.8: the backing store is bounded by DEGRADING the effective dpr, never
        // the CSS size — 3-5 resident pages at ZOOM_MAX would otherwise be 1.25-2.1 GB
        // (spec §4.4). Below the cap this is the identity, so page 1 at fit is
        // byte-identical to v0.6.
        const capped = capBitmapPixels(dims.cssW, dims.cssH, dpr)
        // Assign ONLY on change: per the HTML spec, setting `canvas.width` resets the
        // bitmap to transparent black even when the value is unchanged, so an
        // unconditional write would blank the page on every wheel notch that happens
        // to land on the same floored size.
        if (canvas.width !== capped.bitmapW) canvas.width = capped.bitmapW
        if (canvas.height !== capped.bitmapH) canvas.height = capped.bitmapH
        // …CSS size stays at the fit-to-width viewport dims (the page CSS-upscales
        // past the cap rather than shrinking).
        canvas.style.width = `${dims.cssW}px`
        canvas.style.height = `${dims.cssH}px`
        // pdf.js v6 `RenderParameters` requires `canvas` (the element); the old
        // `canvasContext` field is now an optional backwards-compat alias. Passing
        // the element lets pdf.js own the 2D context internally.
        const task = p.render({ canvas, viewport: vp, transform: capped.transform })
        renderTaskRef.current = task
        await task.promise
        if (cancelled) return
        textLayerDiv.replaceChildren() // idempotent guard against double-invoke
        // The text layer sizes its glyphs from `--total-scale-factor` (pdf_viewer.css).
        // pdf.js only auto-derives that var under a `.pdfViewer .page` ancestor, which
        // this markup omits — so set it explicitly. It MUST be `vp.scale` and never
        // `capped`'s effective dpr: the cap changes only raster resolution, so an
        // overlay that followed it would drift out of alignment exactly where the cap
        // engages and every excerpt rect captured there would be silently wrong
        // (`capBitmapPixels.ts:35-39`).
        textLayerDiv.style.setProperty('--scale-factor', String(vp.scale))
        textLayerDiv.style.setProperty('--total-scale-factor', String(vp.scale))
        const textLayer = new TextLayer({
          textContentSource: p.streamTextContent(),
          container: textLayerDiv,
          viewport: vp,
        })
        textLayerRef.current = textLayer
        await textLayer.render()
        if (cancelled) return
        // Registered only once the overlay exists: an entry whose text layer has not
        // rendered would resolve a selection that cannot yet be made.
        registryRef.current.set(pageNumber, { page: p, viewport: vp, contentEl })
      })
      .catch((err) => {
        // `renderTask.cancel()` rejects the awaited render promise with
        // RenderingCancelledException and `textLayer.cancel()` rejects `render()`
        // with AbortException (`pdfjs-dist/build/pdf.mjs:14795-14800`) — both are the
        // expected shape of a scale change or unmount, so swallow them; surface any
        // real failure instead of a blank canvas.
        const name = (err as { name?: string })?.name
        if (name !== 'RenderingCancelledException' && name !== 'AbortException')
          console.error('[PdfPage] page render failed', pageNumber, err)
      })
    // Scale change AND unmount: cancel the in-flight raster. This is step 8 of the
    // teardown order, and it lands before the unmount effect below because React
    // destroys a component's hook cleanups in declaration order.
    return () => {
      cancelled = true
      renderTaskRef.current?.cancel()
    }
  }, [doc, pageNumber, containerWidth, zoom, registryRef])

  // Unmount ONLY (steps 9-10). Everything is read from refs at teardown time, so
  // the empty dep array is load-bearing: adding a dep would run this on a scale
  // change and cleanup/deregister a page that is merely re-rasterizing.
  //
  // `page.cleanup()` after the cancel above is a promptness decision, not a
  // correctness one: `PDFPageProxy.#tryCleanup()` returns false while any intent
  // state has `renderTasks.size > 0` (`pdfjs-dist/build/pdf.mjs:15701-15717`, the
  // guard at `:15709-15711`), and the render task's completion handler calls it
  // again (`:15535`) — so calling cleanup first only DEFERS the release. At book
  // scale, prompt release is the whole point.
  // biome-ignore lint/correctness/useExhaustiveDependencies: unmount-only teardown; pageNumber is fixed per instance (the reader keys items by page number) and registryRef is a stable ref
  useEffect(() => {
    // Captured at MOUNT, not read from the ref at teardown: React detaches host
    // refs (`safelyDetachRef`) during commitDeletionEffects, which runs before
    // passive-effect destroy functions — so `canvasRef.current` is already null
    // here and the backing store would silently never be released.
    const canvas = canvasRef.current
    return () => {
      textLayerRef.current?.cancel()
      pageRef.current?.cleanup()
      if (canvas) {
        canvas.width = 0
        canvas.height = 0
      }
      registryRef.current.delete(pageNumber)
    }
  }, [])

  return (
    // data-index → the virtualizer's measureElement (indexAttribute default);
    // data-page-number → excerpt page resolution (spec §4.7). The wrapper carries
    // NO border/padding/shadow — inter-page separation is the virtualizer's `gap`,
    // which folds into item `start`, not `size` (`usePdfPageDims.ts:23-26`).
    <div
      data-index={pageNumber - 1}
      data-page-number={pageNumber}
      ref={measureRef}
      style={{ height: css?.h }}
    >
      <div ref={contentRef} style={{ position: 'relative', margin: '0 auto', width: css?.w }}>
        <canvas ref={canvasRef} style={{ display: 'block' }} />
        <div
          ref={textLayerElRef}
          className="textLayer"
          style={{ position: 'absolute', inset: 0, overflow: 'hidden' }}
        />
      </div>
    </div>
  )
}
