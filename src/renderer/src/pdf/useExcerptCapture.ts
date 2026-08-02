import { useEffect } from 'react'
import { clientRectsToPdfRect } from './clientRectsToPdfRect'
import { useExcerptStore } from './excerptState'
import { locateQuoteInPageText } from './locateQuoteInPageText'
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
      // `null` now means the quote is GENUINELY ABSENT from this page's text — in
      // practice a cross-page selection, whose tail lives on page N+1. The guards below
      // then omit all four fields: deliberate, honest degradation (ADR 0058).
      //
      // Through v0.8 this was `fullText.indexOf(text)`, and the comment here said the
      // same thing — which is why #189 went unnoticed for two milestones. `indexOf`
      // ALSO returned -1 for every MULTI-LINE selection on a single page, because
      // `sel.toString()` joins visual lines with `\n` while `fullText` joins
      // `getTextContent()` items with a space. That is a failing path this comment made
      // look intended. The helper matches on a whitespace-insensitive basis and reports
      // RAW offsets into `fullText`, so only real absence reaches the `null` branch and
      // the offset basis every persisted locator uses is unchanged.
      //
      // Note the asymmetry it introduces: the helper TRIMS the quote before matching,
      // so `[textStart, textEnd)` spans the trimmed text while `quote` below stores
      // `sel.toString()` verbatim. A selection ending on a line break therefore has
      // `quote.length !== textEnd - textStart`. Both are correct; they measure
      // different strings, and no reader combines them (ADR 0059 — `rect` is primary).
      // NOT `range` — that name is already the DOM Range this selection came from
      // (`:51`), and rebinding it here would be a redeclaration in the same block.
      const quoteRange = locateQuoteInPageText(fullText, text)
      const prefix = quoteRange
        ? fullText.slice(Math.max(0, quoteRange.start - 32), quoteRange.start)
        : ''
      const suffix = quoteRange ? fullText.slice(quoteRange.end, quoteRange.end + 32) : ''
      const textStart = quoteRange?.start
      const textEnd = quoteRange?.end
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
