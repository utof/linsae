import { useQuery } from '@tanstack/react-query'
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from 'pdfjs-dist'
import * as pdfjs from 'pdfjs-dist'
import { useEffect, useRef } from 'react'
import { api } from '../lib/api'

// Configure the worker (blob-wrapped, same-origin per mozilla/pdf.js #9676).
// The exact workerSrc URL is the bundled worker — Vite resolves this at build.
// CSP `worker-src 'self' blob:` (Task 6) permits this same-origin worker.
pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.mjs',
  import.meta.url,
).toString()

/**
 * Load a PDF document via pdf.js for rendering. Disposes via
 * `loadingTask.destroy()` on unmount/query invalidation — NOTE: v6 removed
 * `PDFDocumentProxy.destroy()` (PR #21245); disposal goes through the
 * loading task held in a ref.
 *
 * Design: one-PDF-at-a-time. A single `loadingTaskRef` tracks the live task;
 * a pdfId swap disposes the prior task (effect cleanup + queryFn pre-dispose)
 * before loading the next. A fuller multi-doc lifecycle (concurrent open
 * documents, an LRU of proxies) is intentionally out of scope for v0.6.
 *
 * @see docs/specs/v0.6-pdf-slim-slice.md §4
 * @see adrs/0043-pdf-engine-pdfjs-dist.md
 */
export function usePdfDocument(pdfId: string | null) {
  const loadingTaskRef = useRef<PDFDocumentLoadingTask | null>(null)

  const query = useQuery({
    queryKey: ['pdf-doc', pdfId] as const,
    enabled: pdfId !== null,
    queryFn: async (): Promise<PDFDocumentProxy | null> => {
      if (!pdfId) return null
      // Dispose any previous loading task before loading a new one.
      loadingTaskRef.current?.destroy().catch(() => {})
      const open = await api.pdf.open(pdfId)
      if (!open) return null
      const res = await fetch(open.mediaUrl)
      const data = new Uint8Array(await res.arrayBuffer())
      const loadingTask: PDFDocumentLoadingTask = pdfjs.getDocument({ data })
      loadingTaskRef.current = loadingTask
      return await loadingTask.promise
    },
    gcTime: 0, // don't cache the doc proxy — disposal is explicit on unmount/swap
  })

  // Dispose on unmount AND whenever pdfId changes (the query invalidates; this
  // effect runs after the old doc is no longer needed). pdfId is a dispose-on-
  // swap TRIGGER, not read in the cleanup — loadingTaskRef holds the live task.
  // biome-ignore lint/correctness/useExhaustiveDependencies: pdfId is the dispose-on-swap trigger (cleanup reads only the stable loadingTaskRef); dropping it would stop disposal on PDF change
  useEffect(() => {
    return () => {
      loadingTaskRef.current?.destroy().catch(() => {})
      loadingTaskRef.current = null
    }
  }, [pdfId])

  return query
}
