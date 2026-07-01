import { useQuery } from '@tanstack/react-query'
import type { PDFDocumentLoadingTask } from 'pdfjs-dist'
import * as pdfjs from 'pdfjs-dist'

// Configure the pdf.js worker. The same workerSrc assignment lives in
// usePdfDocument.ts; setting it here ensures thumbnails can render even if
// the PdfReader panel has never mounted (i.e. usePdfDocument.ts not yet
// imported). Setting the same URL twice is idempotent.
// @see src/renderer/src/pdf/usePdfDocument.ts
// @see adrs/0043-pdf-engine-pdfjs-dist.md @issue utof/linsae#152
pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.mjs',
  import.meta.url,
).toString()

/** Width (CSS px) of the off-screen render canvas for thumbnail generation. */
const THUMB_RENDER_WIDTH_PX = 80

/**
 * Renders PDF page 1 to a JPEG data-URL once per session, cached by sha256
 * (staleTime: Infinity). The render uses a detached off-screen canvas and
 * the loading task is destroyed immediately after to free pdf.js worker memory.
 *
 * Why cache by sha256 (content-hash, not pdfId): the same PDF re-imported
 * gets the same thumbnail without a second render.
 *
 * Why staleTime + gcTime: Infinity: page-1 content does not change in a session.
 * staleTime keeps the cached data-URL fresh forever; gcTime: Infinity stops React
 * Query from garbage-collecting the entry while every PdfFeedNote for this sha256
 * is scrolled off-screen (virtualized-out → zero observers), which would otherwise
 * force a re-render on scroll-back after the default 5-min gcTime. Together they
 * make the render genuinely once-per-session — the key perf constraint for the
 * virtualized feed. React Query also deduplicates concurrent fetches, so two cards
 * for the same sha256 only render once.
 *
 * Why off-screen canvas: `document.createElement('canvas')` is never appended
 * to the DOM, so the render does not trigger layout and the element is
 * immediately GC-able after the data-URL is extracted.
 *
 * @see src/renderer/src/pdf/usePdfDocument.ts (full reader pipeline)
 * @see adrs/0005-tanstack-virtual.md (feed virtualisation)
 * @issue utof/linsae#167
 */
export function usePdfThumbnail(
  sha256: string | null | undefined,
  mediaUrl: string | null | undefined,
) {
  return useQuery({
    queryKey: ['pdfThumb', sha256] as const,
    enabled: !!sha256 && !!mediaUrl,
    staleTime: Infinity,
    gcTime: Infinity,
    queryFn: async (): Promise<string> => {
      const res = await fetch(mediaUrl!)
      const data = new Uint8Array(await res.arrayBuffer())
      let loadingTask: PDFDocumentLoadingTask | null = null
      try {
        loadingTask = pdfjs.getDocument({ data })
        const doc = await loadingTask.promise
        const page = await doc.getPage(1)
        const unscaled = page.getViewport({ scale: 1 })
        const scale = THUMB_RENDER_WIDTH_PX / unscaled.width
        const viewport = page.getViewport({ scale })
        const canvas = document.createElement('canvas')
        canvas.width = Math.round(viewport.width)
        canvas.height = Math.round(viewport.height)
        const renderTask = page.render({ canvas, viewport })
        await renderTask.promise
        return canvas.toDataURL('image/jpeg', 0.85)
      } finally {
        // v6: PDFDocumentProxy.destroy() was removed (PR #21245); disposal
        // goes through the loading task. @see usePdfDocument.ts (same pattern)
        await loadingTask?.destroy().catch(() => {})
      }
    },
  })
}
