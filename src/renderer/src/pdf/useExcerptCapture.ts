import { useEffect } from 'react'
import { clientRectsToPdfRect } from './clientRectsToPdfRect'
import { useExcerptStore } from './excerptState'
import type { PageRegistryEntry } from './PdfPage'

interface UseExcerptCaptureArgs {
  pdfId: string
  /**
   * The reader's page registry (`PdfReader.tsx:140`), read via `.current` at EVENT
   * time. A ref, not state: N mounted pages register/deregister on every scroll
   * frame, and a state-backed registry — or one in this effect's dep array — would
   * re-bind the `mouseup` listener each time. @see docs/specs/v0.8-multipage-pdf.md §4.7
   */
  registryRef: React.RefObject<Map<number, PageRegistryEntry>>
  /** Element the mouseup listener binds to (the scroll container, so a drag
   * released anywhere in the pane is still captured). */
  scrollEl: HTMLElement | null
}

/**
 * On mouseup inside the reader's scroll container, build the hybrid source_locator
 * (quote + prefix/suffix + rect + best-effort textStart/textEnd) and store it in
 * excerptState. Esc clears.
 *
 * v0.8: the anchor page is resolved FROM THE SELECTION rather than from
 * reader-held state — a continuous-scroll list has no single page, viewport or
 * origin element. `range.startContainer` names the page, the registry supplies
 * that page's `{page, viewport, contentEl}`, and the coordinate math (steps 4-6
 * below) is v0.6's unchanged, just against a different origin element. That is what
 * makes the page-1 no-regression test byte-for-byte comparable.
 *
 * Coordinates are measured against the anchor page's `contentEl` (its origin)
 * rather than the scroll container, so the captured rect is correct at any zoom and
 * scroll position — `convertToPdfPoint` divides by the (zoom-inclusive) viewport
 * scale, so the same viewport handles zoom ≠ 1 with no extra math.
 *
 * @see docs/specs/v0.8-multipage-pdf.md §4.7 (the excerpt seam)
 * @see docs/specs/v0.6-pdf-slim-slice.md §7 (capture→place)
 * @issue utof/linsae#154
 */
export function useExcerptCapture({ pdfId, registryRef, scrollEl }: UseExcerptCaptureArgs): void {
  const set = useExcerptStore((s) => s.set)
  const clear = useExcerptStore((s) => s.clear)

  useEffect(() => {
    if (!scrollEl) return
    const onPageMouseUp = async () => {
      const sel = window.getSelection()
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return
      const range = sel.getRangeAt(0)
      const text = sel.toString()
      if (!text.trim()) return
      // Element-safe walk-up: a legal Range boundary point is `(element, childIndex)`,
      // so `startContainer` can itself be an Element — and when it is the page wrapper,
      // a bare `.parentElement?.closest(…)` climbs PAST it and resolves nothing
      // (`closest` matches self). @see docs/specs/v0.8-multipage-pdf.md §4.7 step 2
      const n = range.startContainer
      const host = (n.nodeType === 1 ? (n as Element) : n.parentElement)?.closest(
        '[data-page-number]',
      )
      if (!host) return
      // A Range's start is before-or-equal its end in TREE ORDER
      // (https://dom.spec.whatwg.org/#concept-range), so this is the visually upper
      // page even on an upward drag. Never `sel.anchorNode` — that IS drag direction.
      const pageNumber = Number(host.getAttribute('data-page-number'))
      // Absent while the page is mounted but its text layer has not rendered yet
      // (`PdfPage.tsx:156-158`): there is no viewport to convert against.
      const entry = registryRef.current.get(pageNumber)
      if (!entry) return

      const pageRect = entry.contentEl.getBoundingClientRect()
      // Keep only rects on the anchor page: a cross-page drag would otherwise produce
      // a bounding box spanning the gap, taller than the page itself. Sound under
      // partial scroll — both `getClientRects()` and `getBoundingClientRect()` are
      // unclipped viewport-space boxes, so ancestor overflow does not clip them.
      const rects = Array.from(range.getClientRects()).filter((r) => {
        // Drop zero-area boxes BEFORE the page test. pdf.js v6's TextLayer emits
        // `<br role="presentation">` between line spans, and their boxes are width 0,
        // height ~21, at x = 0 relative to the content box — with the topmost one
        // sitting slightly ABOVE the page. `clientRectsToPdfRect` unions whatever it
        // is given (`clientRectsToPdfRect.ts:21-28`), so a multi-line selection would
        // report a rect starting at the page's left edge and overflowing its top,
        // rather than one bounding the selected text. The page test alone does not
        // catch it: a box at top -3 with height 21 has centre +7.5 and passes.
        // Caught by the real-Electron smoke gate; happy-dom renders no text layer.
        // @see scripts/pdf-multipage-smoke.mjs (excerpt-rect-geometry)
        // Derived from the edges rather than r.width/r.height: those are the only
        // four fields `clientRectsToPdfRect` itself consumes, so the check holds for
        // any rect-like this is ever handed, not just a real DOMRect.
        if (r.right - r.left <= 0 || r.bottom - r.top <= 0) return false
        const cy = (r.top + r.bottom) / 2
        return cy >= pageRect.top && cy <= pageRect.bottom
      })
      // pdf.js types `convertToPdfPoint` as `any[]`; the helper wants `[number, number]`
      // (it always returns a 2-tuple at runtime). Cast to the helper's own param type.
      const rect = clientRectsToPdfRect(
        entry.viewport as unknown as Parameters<typeof clientRectsToPdfRect>[0],
        pageRect,
        rects,
      )
      // prefix/suffix: ~32 chars around the selection for disambiguation
      const fullText = await entry.page
        .getTextContent()
        .then((tc) => tc.items.map((i) => ('str' in i ? i.str : '')).join(' '))
        // getTextContent rejects if the page transport is torn down mid-selection
        // (e.g. usePdfDocument's loadingTask.destroy()); degrade to no prefix/suffix
        // rather than leak an unhandled rejection from this async listener.
        .catch(() => '')
      // A cross-page quote cannot occur in the anchor page's own text, so `idx` is -1
      // and the guards below omit all four fields — deliberate, honest degradation
      // (ADR 0058). Unchanged from v0.6 by design; no new branch.
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
          page: pageNumber,
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
        page: pageNumber,
      })
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') clear()
    }
    scrollEl.addEventListener('mouseup', onPageMouseUp)
    window.addEventListener('keydown', onKey)
    return () => {
      scrollEl.removeEventListener('mouseup', onPageMouseUp)
      window.removeEventListener('keydown', onKey)
    }
  }, [registryRef, scrollEl, pdfId, set, clear])
}
