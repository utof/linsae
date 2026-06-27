import type { PageViewport, PDFPageProxy, RenderTask } from 'pdfjs-dist'
import { TextLayer } from 'pdfjs-dist'
import { useEffect, useRef, useState } from 'react'
import { useExcerptStore } from './excerptState'
import { useExcerptCapture } from './useExcerptCapture'
import { usePdfDocument } from './usePdfDocument'
import { usePdfOpenId } from './usePdfOpenId'

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
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const textLayerRef = useRef<HTMLDivElement>(null)
  const pending = useExcerptStore((s) => s.pending)
  const arm = useExcerptStore((s) => s.arm)

  // Render page 1 (v0.6: single-page; multi-page nav is a queued nit).
  useEffect(() => {
    if (!doc || !canvasRef.current || !textLayerRef.current) return
    let renderTask: RenderTask | null = null
    let cancelled = false
    doc
      .getPage(1)
      .then(async (p) => {
        if (cancelled) return
        const vp = p.getViewport({ scale: 1.2 })
        const canvas = canvasRef.current!
        canvas.width = vp.width
        canvas.height = vp.height
        // pdf.js v6 `RenderParameters` requires `canvas` (the element); the old
        // `canvasContext` field is now an optional backwards-compat alias — see
        // node_modules/pdfjs-dist/types/src/display/api.d.ts (`canvas:
        // HTMLCanvasElement | null`). Passing the element lets pdf.js own the 2D
        // context internally (build/pdf.mjs falls back to `canvas.getContext`).
        renderTask = p.render({ canvas, viewport: vp })
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
  }, [doc])

  useExcerptCapture({ pdfId: pdfId ?? '', page, viewport, pageEl })

  if (!pdfId)
    return <div style={{ padding: 'var(--space-4)', color: 'var(--fg-2)' }}>No PDF open.</div>

  return (
    <div
      ref={setPageEl}
      style={{
        position: 'relative',
        width: '100%',
        height: '100%',
        overflow: 'auto',
        background: 'var(--bg-0)',
      }}
    >
      <div style={{ position: 'relative', margin: '0 auto', display: 'inline-block' }}>
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
