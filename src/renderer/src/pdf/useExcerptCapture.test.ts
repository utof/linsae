import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { stubPageRects } from '../../../../tests/pdf-layout'
import { useExcerptStore } from './excerptState'
import type { PageRegistryEntry } from './PdfPage'
import { useExcerptCapture } from './useExcerptCapture'

/**
 * CSS height of every stubbed page. `stubPageRects` lays pages out at this stride,
 * so page N's content box spans `[(N-1)*PAGE_CSS_HEIGHT, N*PAGE_CSS_HEIGHT]` in
 * client coords — which is what makes "is this rect on the anchor page?" decidable.
 */
const PAGE_CSS_HEIGHT = 1000
/** The same page in PDF user space (US Letter portrait). */
const PAGE_PDF_HEIGHT = 792
const PAGE_CSS_WIDTH = 900

interface ViewportLike {
  convertToPdfPoint: (x: number, y: number) => [number, number]
}

/**
 * The v0.6 test's viewport, verbatim (`useExcerptCapture.test.ts:33` before this
 * rewrite): identity, so the asserted rect numbers ARE the client-rect numbers and
 * the no-regression comparison is byte-for-byte.
 */
const IDENTITY_VIEWPORT: ViewportLike = {
  convertToPdfPoint: (x, y) => [x, y],
}

/**
 * A pdf.js-shaped viewport: CSS px → PDF user space, WITH the y-flip (`PageViewport`
 * sets `rotateD = -1` at rotation 0). Only the smearing test needs it: under the
 * identity viewport a cross-page bounding box is measured in CSS px and would slip
 * under `PAGE_PDF_HEIGHT` by accident, so the filter assertion would pass for the
 * wrong reason.
 */
const SCALE = PAGE_CSS_HEIGHT / PAGE_PDF_HEIGHT
const FLIP_VIEWPORT: ViewportLike = {
  convertToPdfPoint: (x, y) => [x / SCALE, PAGE_PDF_HEIGHT - y / SCALE],
}

/**
 * Page body text. Byte-identical to the v0.6 fixture, so the no-regression offsets
 * (prefix `'before '`, suffix `' after'`, textStart 7, textEnd 24) are the same
 * numbers this hook produced at v0.6.
 */
const PAGE_TEXT = 'before the selected text after'
const QUOTE = 'the selected text'
const QUOTE_START = PAGE_TEXT.indexOf(QUOTE) // 7
const QUOTE_END = QUOTE_START + QUOTE.length // 24

interface MountedPage {
  /** The `[data-page-number]` wrapper — what `closest()` must resolve to. */
  wrapper: HTMLElement
  /** The content box whose top-left is the page origin (`PdfPage.tsx:218`). */
  content: HTMLElement
  textNode: Text
}

interface Mounted {
  scrollEl: HTMLElement
  registryRef: { current: Map<number, PageRegistryEntry> }
  pages: Map<number, MountedPage>
  /** The pending-excerpt sticky bar: inside the scroller, outside every page. */
  bar: HTMLElement
}

/**
 * Build the reader's DOM for the given pages and the registry they would have
 * published. Mirrors `PdfReader.tsx:452-471` (absolute wrapper) and
 * `PdfPage.tsx:212-226` (`[data-page-number]` › content › textLayer › span › text).
 */
function mountPages(
  specs: Array<{ pageNumber: number; text?: string; viewport?: ViewportLike }>,
): Mounted {
  const scrollEl = document.createElement('div')
  const spacer = document.createElement('div')
  scrollEl.appendChild(spacer)
  document.body.appendChild(scrollEl)

  const registryRef = { current: new Map<number, PageRegistryEntry>() }
  const pages = new Map<number, MountedPage>()

  for (const spec of specs) {
    const text = spec.text ?? PAGE_TEXT
    const positioned = document.createElement('div')
    const wrapper = document.createElement('div')
    wrapper.setAttribute('data-index', String(spec.pageNumber - 1))
    wrapper.setAttribute('data-page-number', String(spec.pageNumber))
    const content = document.createElement('div')
    const textLayer = document.createElement('div')
    textLayer.className = 'textLayer'
    const span = document.createElement('span')
    const textNode = document.createTextNode(text)
    span.appendChild(textNode)
    textLayer.appendChild(span)
    content.appendChild(textLayer)
    wrapper.appendChild(content)
    positioned.appendChild(wrapper)
    spacer.appendChild(positioned)

    registryRef.current.set(spec.pageNumber, {
      page: {
        pageNumber: spec.pageNumber,
        getTextContent: vi.fn().mockResolvedValue({ items: [{ str: text }] }),
      },
      viewport: spec.viewport ?? IDENTITY_VIEWPORT,
      contentEl: content,
    } as unknown as PageRegistryEntry)
    pages.set(spec.pageNumber, { wrapper, content, textNode })
  }

  // The affordance bar (`PdfReader.tsx:474-490`) — the only place a selection can
  // live that is inside the scroller yet outside every page.
  const bar = document.createElement('div')
  bar.appendChild(document.createTextNode('Excerpt place on canvas'))
  scrollEl.appendChild(bar)

  return { scrollEl, registryRef, pages, bar }
}

interface ClientRectLike {
  left: number
  top: number
  right: number
  bottom: number
}

/**
 * Publish `range` as the window selection. `getClientRects` is overridden on the
 * range INSTANCE because happy-dom performs no layout — its `Range.getClientRects()`
 * returns an empty list (probe-verified), which would make every rect assertion
 * vacuously `[0,0,0,0]`. `toString()` is the REAL range's, so a cross-page quote is
 * genuinely produced by the DOM rather than asserted into existence.
 */
function stubSelection(range: Range, clientRects: ClientRectLike[]): void {
  Object.defineProperty(range, 'getClientRects', { configurable: true, value: () => clientRects })
  vi.spyOn(window, 'getSelection').mockReturnValue({
    isCollapsed: false,
    rangeCount: 1,
    toString: () => range.toString(),
    getRangeAt: () => range,
  } as unknown as Selection)
}

/** A client rect on page `n`, given its offset from that page's own top edge. */
function rectOnPage(
  n: number,
  {
    top,
    height,
    left = 10,
    width = 50,
  }: { top: number; height: number; left?: number; width?: number },
): ClientRectLike {
  const y = (n - 1) * PAGE_CSS_HEIGHT + top
  return { left, top: y, right: left + width, bottom: y + height }
}

/**
 * Dispatch the mouseup and let the handler settle. The listener is `async` and
 * awaits `getTextContent()`, so a bare dispatch returns before `set` runs; the
 * macrotask tick drains every pending microtask deterministically.
 */
async function mouseUp(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 0))
  })
}

const pending = () => useExcerptStore.getState().pending

let restoreRects: (() => void) | null = null

describe('useExcerptCapture', () => {
  beforeEach(() => {
    useExcerptStore.getState().clear()
    vi.restoreAllMocks()
    // Every test needs page geometry: without it `contentEl.getBoundingClientRect()`
    // is happy-dom's all-zero rect and page 3 is indistinguishable from page 1.
    restoreRects = stubPageRects(PAGE_CSS_HEIGHT, PAGE_CSS_WIDTH)
  })

  afterEach(() => {
    restoreRects?.()
    restoreRects = null
    document.body.replaceChildren()
  })

  it('PAGE-1 NO-REGRESSION: a page-1 selection produces the identical v0.6 locator', async () => {
    // Byte-for-byte the v0.6 expectations, through the NEW registry-based path. If
    // this ever fails, the milestone has broken its reason to exist.
    const { scrollEl, registryRef, pages } = mountPages([{ pageNumber: 1 }])
    const page1 = pages.get(1) as MountedPage
    const range = document.createRange()
    range.setStart(page1.textNode, QUOTE_START)
    range.setEnd(page1.textNode, QUOTE_END)
    // The v0.6 fixture's client rect verbatim. Page 1's band is [0, 1000], so it
    // survives the new filter unchanged.
    stubSelection(range, [{ left: 10, top: 10, right: 60, bottom: 30 }])

    renderHook(() => useExcerptCapture({ pdfId: 'pdf-1', registryRef, scrollEl }))
    await mouseUp(page1.wrapper)

    const p = pending()
    expect(p).not.toBeNull()
    expect(p?.locator.media).toBe('pdf')
    expect(p?.locator.pdf_id).toBe('pdf-1')
    expect(p?.locator.page).toBe(1)
    expect(p?.locator.quote).toBe(QUOTE)
    expect(p?.locator.prefix).toBe('before ')
    expect(p?.locator.suffix).toBe(' after')
    expect(p?.locator.textStart).toBe(7)
    expect(p?.locator.textEnd).toBe(24)
    // Identity viewport ⇒ the PDF rect IS the client rect, minus page 1's origin (0,0).
    expect(p?.locator.rect).toEqual([10, 10, 50, 20])
    expect(p?.text).toBe(QUOTE)
    expect(p?.pdfId).toBe('pdf-1')
    expect(p?.page).toBe(1)
    // B3: selecting text must never arm placement (that's the affordance's job).
    expect(useExcerptStore.getState().armed).toBe(false)
  })

  it('a selection inside page 3 produces a locator with page: 3, measured from page 3s origin', async () => {
    // Pages 1-2 carry DIFFERENT text on purpose: with every page holding the same
    // string, reading `getTextContent()` off the wrong registry entry would produce
    // identical prefix/suffix and the assertions below would pass regardless
    // (mutation-verified).
    const { scrollEl, registryRef, pages } = mountPages([
      { pageNumber: 1, text: 'page one has entirely different words' },
      { pageNumber: 2, text: 'so does page two' },
      { pageNumber: 3 },
    ])
    const page3 = pages.get(3) as MountedPage
    const range = document.createRange()
    range.setStart(page3.textNode, QUOTE_START)
    range.setEnd(page3.textNode, QUOTE_END)
    // Same offsets WITHIN page 3 as the page-1 case above, 2000px lower in client
    // space. The identical resulting rect is the proof that the origin used was
    // page 3's own content box and not page 1's.
    stubSelection(range, [rectOnPage(3, { top: 10, height: 20 })])

    renderHook(() => useExcerptCapture({ pdfId: 'pdf-1', registryRef, scrollEl }))
    await mouseUp(page3.wrapper)

    const p = pending()
    expect(p?.locator.page).toBe(3)
    expect(p?.page).toBe(3)
    expect(p?.locator.quote).toBe(QUOTE)
    expect(p?.locator.rect).toEqual([10, 10, 50, 20])
    // …and the disambiguators come from PAGE 3's text, not some other resident page's.
    expect(p?.locator.prefix).toBe('before ')
    expect(p?.locator.suffix).toBe(' after')
    expect(p?.locator.textStart).toBe(7)
    expect(p?.locator.textEnd).toBe(24)
  })

  it('resolves the page when startContainer is an ELEMENT, not a text node', async () => {
    // A legal Range boundary point is (element, childIndex). The discriminating case
    // is `startContainer === the page wrapper itself`: `closest()` matches self, so
    // the buggy `.parentElement?.closest(…)` climbs PAST the wrapper and finds
    // nothing (probe-verified). With the boundary set on the CONTENT element instead
    // — as the plan sketch has it — the buggy form still resolves page 3, because
    // `content.parentElement` IS the wrapper. That variant does not bite; this does.
    const { scrollEl, registryRef, pages } = mountPages([{ pageNumber: 3 }])
    const page3 = pages.get(3) as MountedPage
    const range = document.createRange()
    range.setStart(page3.wrapper, 0)
    range.setEnd(page3.textNode, QUOTE_END)
    stubSelection(range, [rectOnPage(3, { top: 10, height: 20 })])

    renderHook(() => useExcerptCapture({ pdfId: 'pdf-1', registryRef, scrollEl }))
    await mouseUp(page3.wrapper)

    expect(pending()?.locator.page).toBe(3)
  })

  it('cross-page selection anchors to the START page (tree order, not drag direction)', async () => {
    const { scrollEl, registryRef, pages } = mountPages([
      { pageNumber: 3 },
      { pageNumber: 4, text: 'page four body text' },
    ])
    const page3 = pages.get(3) as MountedPage
    const page4 = pages.get(4) as MountedPage
    const range = document.createRange()
    range.setStart(page3.textNode, QUOTE_START)
    range.setEnd(page4.textNode, 'page four'.length)
    stubSelection(range, [
      rectOnPage(3, { top: 900, height: 20 }),
      rectOnPage(4, { top: 10, height: 20 }),
    ])

    renderHook(() => useExcerptCapture({ pdfId: 'pdf-1', registryRef, scrollEl }))
    await mouseUp(page3.wrapper)

    const p = pending()
    expect(p?.locator.page).toBe(3)
    // `quote` is the FULL selection, spanning both pages (ADR 0058).
    expect(p?.locator.quote).toBe('the selected text afterpage four')
    // The anchor page's getTextContent() cannot contain a cross-page quote, so
    // `indexOf` returns -1 and the EXISTING idx guards omit all four fields. Honest
    // degradation, no new branch.
    expect(p?.locator.textStart).toBeUndefined()
    expect(p?.locator.textEnd).toBeUndefined()
    expect(p?.locator.prefix).toBe('')
    expect(p?.locator.suffix).toBe('')
  })

  it('filters client rects to the anchor page (rect not smeared across the gap)', async () => {
    // A real cross-page drag: from near the TOP of page 3 to near the BOTTOM of
    // page 4. Unfiltered, the bounding box spans ~1800 CSS px ≈ 1425 PDF units —
    // nearly two pages tall.
    const { scrollEl, registryRef, pages } = mountPages([
      { pageNumber: 3, viewport: FLIP_VIEWPORT },
      { pageNumber: 4, text: 'page four body text', viewport: FLIP_VIEWPORT },
    ])
    const page3 = pages.get(3) as MountedPage
    const page4 = pages.get(4) as MountedPage
    const range = document.createRange()
    range.setStart(page3.textNode, 0)
    range.setEnd(page4.textNode, 'page four'.length)
    stubSelection(range, [
      rectOnPage(3, { top: 100, height: 40, width: 390 }),
      rectOnPage(4, { top: 900, height: 40, width: 390 }),
    ])

    renderHook(() => useExcerptCapture({ pdfId: 'pdf-1', registryRef, scrollEl }))
    await mouseUp(page3.wrapper)

    const rect = pending()?.locator.rect
    expect(rect).toBeDefined()
    // Non-degenerate: a dropped-everything filter would also satisfy the bound below.
    expect((rect as number[])[3]).toBeGreaterThan(0)
    expect((rect as number[])[3]).toBeLessThanOrEqual(PAGE_PDF_HEIGHT)
    // Exactly page 3's 40 CSS px of selection, in PDF units.
    expect((rect as number[])[3]).toBeCloseTo(40 / SCALE, 6)
  })

  it('rounds the rect to 3 decimals (v0.6 behaviour)', async () => {
    const { scrollEl, registryRef, pages } = mountPages([{ pageNumber: 1 }])
    const page1 = pages.get(1) as MountedPage
    const range = document.createRange()
    range.setStart(page1.textNode, QUOTE_START)
    range.setEnd(page1.textNode, QUOTE_END)
    stubSelection(range, [{ left: 10.123456, top: 20.987654, right: 60.5, bottom: 30.5 }])

    renderHook(() => useExcerptCapture({ pdfId: 'pdf-1', registryRef, scrollEl }))
    await mouseUp(page1.wrapper)

    expect(pending()?.locator.rect).toEqual([10.123, 20.988, 50.377, 9.512])
  })

  it('bails when the selection is outside any page (the sticky affordance bar)', async () => {
    const { scrollEl, registryRef, bar } = mountPages([{ pageNumber: 1 }])
    const range = document.createRange()
    range.setStart(bar.firstChild as Text, 0)
    range.setEnd(bar.firstChild as Text, 7)
    stubSelection(range, [{ left: 10, top: 10, right: 60, bottom: 30 }])

    renderHook(() => useExcerptCapture({ pdfId: 'pdf-1', registryRef, scrollEl }))
    await mouseUp(bar)

    expect(pending()).toBeNull()
  })

  it('bails when the anchor page is not (yet) in the registry', async () => {
    // The page wrapper is in the DOM but its text layer has not rendered, so
    // `PdfPage` has not registered it (`PdfPage.tsx:156-158`). Resolving the number
    // is not enough — there is no viewport to convert against.
    //
    // Page 4 stays REGISTERED on purpose: with an empty registry a "fall back to any
    // resident entry" bug also yields nothing, and this test would pass for the wrong
    // reason (mutation-verified).
    const { scrollEl, registryRef, pages } = mountPages([
      { pageNumber: 3 },
      { pageNumber: 4, text: 'page four body text' },
    ])
    const page3 = pages.get(3) as MountedPage
    registryRef.current.delete(3)
    const range = document.createRange()
    range.setStart(page3.textNode, QUOTE_START)
    range.setEnd(page3.textNode, QUOTE_END)
    stubSelection(range, [rectOnPage(3, { top: 10, height: 20 })])

    renderHook(() => useExcerptCapture({ pdfId: 'pdf-1', registryRef, scrollEl }))
    await mouseUp(page3.wrapper)

    expect(pending()).toBeNull()
  })

  it('ignores a whitespace-only selection (v0.6 trim bail)', async () => {
    const { scrollEl, registryRef, pages } = mountPages([
      { pageNumber: 1, text: '   \n  spaced out' },
    ])
    const page1 = pages.get(1) as MountedPage
    const range = document.createRange()
    range.setStart(page1.textNode, 0)
    range.setEnd(page1.textNode, 6)
    stubSelection(range, [{ left: 10, top: 10, right: 60, bottom: 30 }])

    renderHook(() => useExcerptCapture({ pdfId: 'pdf-1', registryRef, scrollEl }))
    await mouseUp(page1.wrapper)

    expect(pending()).toBeNull()
  })

  it('ignores a collapsed selection (no pending stored)', async () => {
    const { scrollEl, registryRef, pages } = mountPages([{ pageNumber: 1 }])
    const page1 = pages.get(1) as MountedPage
    vi.spyOn(window, 'getSelection').mockReturnValue({
      isCollapsed: true,
      rangeCount: 0,
    } as unknown as Selection)

    renderHook(() => useExcerptCapture({ pdfId: 'p', registryRef, scrollEl }))
    await mouseUp(page1.wrapper)

    expect(pending()).toBeNull()
  })

  it('binds the mouseup listener ONCE — a registry mutation must not re-bind it', async () => {
    // Spec §4.7's reason for the registry being a ref: N pages register/deregister on
    // every scroll frame, and a state-backed registry (or one in the dep array) would
    // re-bind the listener each time.
    const { scrollEl, registryRef, pages } = mountPages([{ pageNumber: 1 }])
    const add = vi.spyOn(scrollEl, 'addEventListener')
    const { rerender } = renderHook(() =>
      useExcerptCapture({ pdfId: 'pdf-1', registryRef, scrollEl }),
    )
    expect(add).toHaveBeenCalledTimes(1)

    // A page scrolls in, then one scrolls out. The registry's SIZE changes in both
    // directions — mutation-verified: a `registryRef.current.size` dep re-binds here,
    // whereas a delete+set pair (size unchanged) would let that bug through.
    registryRef.current.set(2, {
      page: { pageNumber: 2, getTextContent: vi.fn().mockResolvedValue({ items: [] }) },
      viewport: IDENTITY_VIEWPORT,
      contentEl: pages.get(1)?.content,
    } as unknown as PageRegistryEntry)
    rerender()
    expect(add).toHaveBeenCalledTimes(1)

    registryRef.current.delete(1)
    rerender()
    expect(add).toHaveBeenCalledTimes(1)
  })

  it('Escape clears a pending excerpt', async () => {
    const { scrollEl, registryRef, pages } = mountPages([{ pageNumber: 1 }])
    const page1 = pages.get(1) as MountedPage
    const range = document.createRange()
    range.setStart(page1.textNode, QUOTE_START)
    range.setEnd(page1.textNode, QUOTE_END)
    stubSelection(range, [{ left: 10, top: 10, right: 60, bottom: 30 }])

    renderHook(() => useExcerptCapture({ pdfId: 'pdf-1', registryRef, scrollEl }))
    await mouseUp(page1.wrapper)
    expect(pending()).not.toBeNull()

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    expect(pending()).toBeNull()
  })
})
