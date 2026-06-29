import type { PageViewport, PDFPageProxy } from 'pdfjs-dist'
import { useEffect } from 'react'
import { clientRectsToPdfRect } from './clientRectsToPdfRect'
import { useExcerptStore } from './excerptState'

interface UseExcerptCaptureArgs {
  pdfId: string
  page: PDFPageProxy | null
  viewport: PageViewport | null
  /** Element the mouseup listener binds to (the scroll container, so a drag
   * released anywhere in the pane is still captured). */
  pageEl: HTMLElement | null
  /** The page-content element (canvas + text-layer wrapper) whose top-left is
   * the true page origin. Used as the `convertToPdfPoint` origin so excerpt
   * rects stay correct when the page is scrolled or zoomed (its
   * `getBoundingClientRect()` already folds in scroll offset + centering).
   * Falls back to `pageEl` when not provided. @see B17/B18 */
  contentEl?: HTMLElement | null
}

/**
 * On selectionchange/mouseup inside the page element, build the hybrid
 * source_locator (quote + prefix/suffix + rect + best-effort textStart/textEnd)
 * and store it in excerptState. Esc clears.
 *
 * Coordinates are measured against `contentEl` (the page origin) rather than the
 * scroll container, so the captured rect is correct at any zoom and scroll
 * position — `convertToPdfPoint` divides by the (zoom-inclusive) viewport scale,
 * so the same viewport handles zoom ≠ 1 with no extra math.
 * @see docs/specs/v0.6-pdf-slim-slice.md §7 (capture→place)
 */
export function useExcerptCapture({
  pdfId,
  page,
  viewport,
  pageEl,
  contentEl,
}: UseExcerptCaptureArgs): void {
  const set = useExcerptStore((s) => s.set)
  const clear = useExcerptStore((s) => s.clear)

  useEffect(() => {
    if (!page || !viewport || !pageEl) return
    const onPageMouseUp = async () => {
      const sel = window.getSelection()
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return
      const range = sel.getRangeAt(0)
      const text = sel.toString()
      if (!text.trim()) return
      // Origin = the page-content element when available (correct under scroll +
      // zoom); otherwise the listener element. @see B17/B18
      const pageRect = (contentEl ?? pageEl).getBoundingClientRect()
      // pdf.js types `convertToPdfPoint` as `any[]`; the helper wants `[number, number]`
      // (it always returns a 2-tuple at runtime). Cast to the helper's own param type.
      const rect = clientRectsToPdfRect(
        viewport as unknown as Parameters<typeof clientRectsToPdfRect>[0],
        pageRect,
        range.getClientRects(),
      )
      // prefix/suffix: ~32 chars around the selection for disambiguation
      const fullText = await page
        .getTextContent()
        .then((tc) => tc.items.map((i) => ('str' in i ? i.str : '')).join(' '))
        // getTextContent rejects if the page transport is torn down mid-selection
        // (e.g. usePdfDocument's loadingTask.destroy()); degrade to no prefix/suffix
        // rather than leak an unhandled rejection from this async listener.
        .catch(() => '')
      const idx = fullText.indexOf(text)
      const prefix = idx > 0 ? fullText.slice(Math.max(0, idx - 32), idx) : ''
      const suffix = idx >= 0 ? fullText.slice(idx + text.length, idx + text.length + 32) : ''
      const textStart = idx >= 0 ? idx : undefined
      const textEnd = idx >= 0 ? idx + text.length : undefined
      set({
        text,
        locator: {
          media: 'pdf',
          pdf_id: pdfId,
          page: page.pageNumber,
          rect: [
            Math.round(rect[0] * 1000) / 1000,
            Math.round(rect[1] * 1000) / 1000,
            Math.round(rect[2] * 1000) / 1000,
            Math.round(rect[3] * 1000) / 1000,
          ],
          quote: text,
          prefix,
          suffix,
          ...(textStart !== undefined ? { textStart } : {}),
          ...(textEnd !== undefined ? { textEnd } : {}),
        },
        pdfId,
        page: page.pageNumber,
      })
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') clear()
    }
    pageEl.addEventListener('mouseup', onPageMouseUp)
    window.addEventListener('keydown', onKey)
    return () => {
      pageEl.removeEventListener('mouseup', onPageMouseUp)
      window.removeEventListener('keydown', onKey)
    }
  }, [page, viewport, pageEl, contentEl, pdfId, set, clear])
}
