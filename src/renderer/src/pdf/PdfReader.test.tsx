import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installPdfLayout, installScrollHeight } from '../../../../tests/pdf-layout'
import { installMockApi, type MockApi } from '../../../../tests/setup'
import type { SessionSnapshot } from '../persistence/keys'
import { computePdfRender } from './computePdfRender'
import { anchorFromOffset, type PageAnchor } from './page-anchor'

// --- Mocks -----------------------------------------------------------------
// pdfjs-dist is only reachable from here through `PdfPage` (stubbed below) and
// `usePdfDocument` (mocked below), so nothing loads the real module — this guard
// keeps that true if an import is ever added back.
vi.mock('pdfjs-dist', () => ({ TextLayer: class {} }))

// Controllable open-pdf id. The reset-on-swap effect keys on `doc` reference
// identity, so we hand out a DISTINCT object per id (swapping the id ⇒ a new
// `doc` ⇒ the reset/restore effect fires).
let currentPdfId: string | null = 'A'
vi.mock('./usePdfOpenId', () => ({
  usePdfOpenId: () => currentPdfId,
  useOpenPdf: () => async () => {},
}))

/** Letter portrait — page 1's dims, and therefore the estimate for every page. */
const PORTRAIT = { width: 612, height: 792 }
/** The one landscape page in the fixture: its real height is FAR off the estimate. */
const LANDSCAPE = { width: 792, height: 612 }
const LANDSCAPE_PAGE = 7
const NUM_PAGES = 500

/** Page whose `getPage(1)` rejects — the #183 blank-pane path. */
let docAFailsPageOne = false

interface DocMock {
  id: string
  numPages: number
  getPage: ReturnType<typeof vi.fn>
}

function makeDoc(id: string): DocMock {
  return {
    id,
    numPages: NUM_PAGES,
    getPage: vi.fn(async (n: number) => {
      if (n === 1 && id === 'A' && docAFailsPageOne) throw new Error('bad page tree')
      const v = n === LANDSCAPE_PAGE ? LANDSCAPE : PORTRAIT
      return {
        pageNumber: n,
        getViewport: () => ({ ...v, scale: 1 }),
        render: () => ({ promise: Promise.resolve(), cancel: () => {} }),
        streamTextContent: () => ({}),
        cleanup: () => {},
      }
    }),
  }
}

let docs: Record<string, DocMock> = { A: makeDoc('A'), B: makeDoc('B') }
vi.mock('./usePdfDocument', () => ({
  usePdfDocument: (id: string | null) => ({ data: id ? docs[id] : undefined }),
}))

// The excerpt-capture wiring is irrelevant to this task (it is knowingly inert
// until Batch 3 rewrites it against the registry); no-op it.
vi.mock('./useExcerptCapture', () => ({ useExcerptCapture: () => {} }))

/**
 * `PdfPage` stub. Deliberately NOT the real component: `PdfPage.test.tsx` covers
 * the raster/teardown/registry contract with a full pdf.js fixture (12 tests), and
 * duplicating it here would make every reader assertion wait on two awaited
 * promises per page. What the stub DOES reproduce is exactly the reader-facing
 * contract asserted on the other side at `PdfPage.test.tsx:292-304`: `data-index`,
 * `data-page-number`, and `measureRef` as the wrapper's `ref`.
 *
 * It renders with NO height — the state `PdfPage` is genuinely in between mount
 * and first raster (`PdfPage.tsx:84`, `:216`). That is the point: it is what a
 * DOM-measuring `measureElement` would sample.
 */
const pageProps: Array<{ pageNumber: number; containerWidth: number; zoom: number }> = []
const registryRefs = new Set<unknown>()
vi.mock('./PdfPage', () => ({
  PdfPage: (props: {
    pageNumber: number
    containerWidth: number
    zoom: number
    registryRef: unknown
    measureRef: (node: HTMLDivElement | null) => void
  }) => {
    pageProps.push({
      pageNumber: props.pageNumber,
      containerWidth: props.containerWidth,
      zoom: props.zoom,
    })
    registryRefs.add(props.registryRef)
    return (
      <div
        data-index={props.pageNumber - 1}
        data-page-number={props.pageNumber}
        ref={props.measureRef}
      />
    )
  },
}))

import { PdfReader } from './PdfReader'

// The persist effect debounces the disk write; wait a hair past it before asserting.
const DEBOUNCE_WAIT_MS = 320

/** Matches `PAGE_GAP_PX` in PdfReader.tsx — the gutter folded into item `start`. */
const PAGE_GAP_PX = 12
const VIEW_W = 900
const VIEW_H = 1000
/** What `estimateHeight` yields for a portrait page at VIEW_W and zoom 1. */
const PORTRAIT_H = computePdfRender(VIEW_W, PORTRAIT.width, PORTRAIT.height, 1, 1).cssH
/** …and for the landscape page. Far shorter — that is what makes the resize visible. */
const LANDSCAPE_H = computePdfRender(VIEW_W, LANDSCAPE.width, LANDSCAPE.height, 1, 1).cssH

/**
 * A QueryClient whose `['session-snapshot']` cache is pre-seeded with the given
 * per-document pdf-view map. useSessionSnapshot (staleTime: Infinity) then returns
 * this synchronously on first render — mirroring the real boot gate that only
 * mounts restorable surfaces AFTER the snapshot has loaded.
 */
function seededClient(pdfView: SessionSnapshot['pdfView']): QueryClient {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const snapshot: SessionSnapshot = {
    dockLayout: null,
    uiSession: null,
    feedScroll: null,
    threadScroll: {},
    draftFeed: null,
    draftThread: {},
    pdfView,
  }
  qc.setQueryData(['session-snapshot'], snapshot)
  return qc
}

/** A ctrl+wheel "zoom in" event, robust to happy-dom not reflecting ctor init. */
function ctrlWheelIn(): WheelEvent {
  const e = new WheelEvent('wheel', {
    bubbles: true,
    cancelable: true,
    ctrlKey: true,
    deltaY: -10,
  })
  if (!e.ctrlKey) Object.defineProperty(e, 'ctrlKey', { value: true })
  if (e.deltaY === 0) Object.defineProperty(e, 'deltaY', { value: -10 })
  return e
}

const flushDebounce = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, DEBOUNCE_WAIT_MS))
  })

/** The outer scroll container (ref={setPageEl}) — where the native wheel listener binds. */
const pageEl = (container: HTMLElement): HTMLElement => container.firstElementChild as HTMLElement

/** Zoom in once and let the debounced persist write flush. */
async function zoomInOnce(container: HTMLElement): Promise<void> {
  await act(async () => {
    pageEl(container).dispatchEvent(ctrlWheelIn())
  })
  await flushDebounce()
}

/** The most recent `window.api.settings.set({ key, value })` payload. */
function lastSet(api: MockApi): { key: string; value: SessionSnapshot['pdfView'] } {
  const calls = api.settings.set.mock.calls
  return calls[calls.length - 1]?.[0]
}

const renderReader = (qc: QueryClient) =>
  render(
    <QueryClientProvider client={qc}>
      <PdfReader />
    </QueryClientProvider>,
  )

const pageNumbers = (container: HTMLElement): number[] =>
  Array.from(container.querySelectorAll('[data-page-number]')).map((el) =>
    Number(el.getAttribute('data-page-number')),
  )

/** The absolutely-positioned wrapper the reader puts AROUND a given page. */
const wrapperFor = (container: HTMLElement, page: number): HTMLElement =>
  container.querySelector(`[data-page-number="${page}"]`)?.parentElement as HTMLElement

/** The spacer whose height is `virtualizer.getTotalSize()`. */
const spacer = (container: HTMLElement): HTMLElement =>
  pageEl(container).firstElementChild as HTMLElement

/** Matches `ZOOM_STEP` inside PdfReader's wheel handler. */
const ZOOM_STEP = 1.1

/**
 * Rendered page height at a given zoom. Every page in the fixture is portrait
 * except `LANDSCAPE_PAGE`, which the re-anchor test never windows — so its dims are
 * never fetched and its estimate is the portrait fallback too. That makes the whole
 * 500-page document a UNIFORM stride at any zoom, which is what lets these helpers
 * reconstruct the virtualizer's geometry without reaching into the instance.
 */
const pageHeightAt = (zoom: number): number =>
  computePdfRender(VIEW_W, PORTRAIT.width, PORTRAIT.height, 1, zoom).cssH

/** Distance from one page's top to the next: height + the `gap` folded into `start`. */
const strideAt = (zoom: number): number => pageHeightAt(zoom) + PAGE_GAP_PX

/** Park the scroller at the top edge of `page` and let the virtualizer see it. */
async function scrollToPage(container: HTMLElement, page: number): Promise<void> {
  await act(async () => {
    pageEl(container).scrollTop = (page - 1) * strideAt(1)
    // happy-dom does not fire `scroll` for a scrollTop assignment; dispatch it so
    // BOTH virtual-core's own listener and the reader's onScroll run.
    pageEl(container).dispatchEvent(new Event('scroll'))
  })
}

/**
 * Where the reader is actually parked, as a page anchor — derived from the live DOM
 * `scrollTop` through the real `anchorFromOffset`, with the item reconstructed from
 * the uniform stride above. Deliberately NOT read off the virtualizer instance: the
 * offset is the thing under test, and a stale-cache bug produces an offset in the
 * OLD scale, which only a fresh-scale reading exposes.
 */
function anchorAt(container: HTMLElement, zoom: number): PageAnchor {
  const size = pageHeightAt(zoom)
  const offset = pageEl(container).scrollTop
  const index = Math.floor(offset / strideAt(zoom))
  return anchorFromOffset(offset, { index, start: index * strideAt(zoom), size })
}

let mockApi: MockApi
let restoreLayout: (() => void) | null = null
let restoreScrollHeight: (() => void) | null = null
beforeEach(() => {
  currentPdfId = 'A'
  docAFailsPageOne = false
  docs = { A: makeDoc('A'), B: makeDoc('B') }
  pageProps.length = 0
  registryRefs.clear()
  mockApi = installMockApi()
  // Each test starts foreground; the quit-flush test flips this and resets it.
  Object.defineProperty(document, 'hidden', { value: false, configurable: true })
})
afterEach(() => {
  restoreLayout?.()
  restoreLayout = null
  restoreScrollHeight?.()
  restoreScrollHeight = null
})

describe('PdfReader virtualized page list', () => {
  it('renders NOTHING until containerWidth > 0 (boot gate)', async () => {
    // Width 0, height 1000 — the state a real dock pane is in for one frame before
    // the ResizeObserver fires, and the ONLY configuration in which this gate is
    // observable. Plain `installPdfLayout()`-less rendering does not test it: with
    // outerSize 0 virtual-core returns a null range regardless of `enabled`
    // (`virtual-core/dist/esm/index.js:calculateRange`, `outerSize === 0` branch), so
    // the assertion would pass with the gate deleted. With a real height and a 0
    // width every estimateSize returns 0, so an ungated virtualizer windows ~84
    // zero-height pages at once — the disaster spec §4.2.1 exists to prevent.
    restoreLayout = installPdfLayout({ width: 0, height: VIEW_H })
    const { container } = renderReader(seededClient({}))

    // Wait for the page-1 dims probe to be ISSUED, then drain the microtask queue on
    // a macrotask tick so it has definitely RESOLVED and React has re-rendered. The
    // gate's other half (`fallback != null`) is therefore satisfied, and what is left
    // holding the list shut is the width.
    await waitFor(() => expect(docs.A?.getPage).toHaveBeenCalledWith(1))
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })

    expect(container.querySelectorAll('[data-page-number]')).toHaveLength(0)
    // Exactly one getPage — the dims seed. The windowed-page prefetch never ran,
    // which is only true if `ready` is false.
    expect(docs.A?.getPage).toHaveBeenCalledTimes(1)
  })

  it('renders a windowed subset of a 500-page document, not 500 canvases', async () => {
    restoreLayout = installPdfLayout({ width: VIEW_W, height: VIEW_H })
    const { container } = renderReader(seededClient({}))

    await waitFor(() => expect(pageNumbers(container).length).toBeGreaterThan(0))
    expect(pageNumbers(container).length).toBeLessThan(10)
    // The document really is 500 pages long — otherwise "windowed" proves nothing.
    expect(docs.A?.numPages).toBe(NUM_PAGES)
    expect(Number.parseFloat(spacer(container).style.height)).toBeGreaterThan(
      (NUM_PAGES - 1) * PORTRAIT_H,
    )
  })

  it('opens a 500-page document with ONE getPage before the first page is windowed', async () => {
    restoreLayout = installPdfLayout({ width: VIEW_W, height: VIEW_H })
    const { container } = renderReader(seededClient({}))
    await waitFor(() => expect(pageNumbers(container).length).toBeGreaterThan(0))

    // The cost model (criterion 2): page 1 seeds the fallback, then only the
    // windowed pages are probed — never 500.
    expect(docs.A?.getPage.mock.calls.length).toBeLessThan(10)
  })

  it('lays pages out at estimateSize + gap, NOT at a DOM-measured height', async () => {
    // The trap this pins: `PdfPage`'s wrapper is height-auto between mount and first
    // raster, so a DOM-measuring `measureElement` writes a transient height into
    // `itemSizeCache`. Under the harness that transient value is VIEW_H (1000, from
    // the stubbed ResizeObserver's borderBoxSize) and in a real browser it is the
    // canvas's intrinsic 150 — either way != PORTRAIT_H, and either way the list
    // collapses. `useCachedMeasurements: true` is what makes this assertion hold.
    restoreLayout = installPdfLayout({ width: VIEW_W, height: VIEW_H })
    const { container } = renderReader(seededClient({}))
    await waitFor(() => expect(pageNumbers(container)).toContain(2))

    expect(PORTRAIT_H).not.toBe(VIEW_H) // guard the guard
    expect(wrapperFor(container, 1).style.transform).toBe('translateY(0px)')
    expect(wrapperFor(container, 2).style.transform).toBe(
      `translateY(${PORTRAIT_H + PAGE_GAP_PX}px)`,
    )
  })

  it('resizes a page whose real dims differ from the estimate (landscape among portrait)', async () => {
    restoreLayout = installPdfLayout({ width: VIEW_W, height: VIEW_H })
    const { container } = renderReader(seededClient({}))
    await waitFor(() => expect(pageNumbers(container).length).toBeGreaterThan(0))

    // Scroll page 7 into the window so the prefetch resolves its dims.
    const stride = PORTRAIT_H + PAGE_GAP_PX
    await act(async () => {
      pageEl(container).scrollTop = (LANDSCAPE_PAGE - 1) * stride
      pageEl(container).dispatchEvent(new Event('scroll'))
    })
    await waitFor(() => expect(pageNumbers(container)).toContain(LANDSCAPE_PAGE))

    // The landscape page fits the SAME width and is therefore much shorter. Asserting
    // the resulting layout, not that `resizeItem` was called: only the layout proves
    // the new dims actually reached the virtualizer (spec §4.2.1 — mutating the dims
    // Map on its own changes nothing).
    expect(LANDSCAPE_H).toBeLessThan(PORTRAIT_H) // guard the guard
    await waitFor(() => {
      const top = (n: number) =>
        Number.parseFloat(wrapperFor(container, n).style.transform.replace(/[^\d.-]/g, ''))
      expect(top(LANDSCAPE_PAGE + 1) - top(LANDSCAPE_PAGE)).toBe(LANDSCAPE_H + PAGE_GAP_PX)
    })
  })

  it('hands every page the SAME registry ref and a pageNumber matching its data attribute', async () => {
    restoreLayout = installPdfLayout({ width: VIEW_W, height: VIEW_H })
    const { container } = renderReader(seededClient({}))
    await waitFor(() => expect(pageNumbers(container).length).toBeGreaterThan(0))

    // One shared Map (a ref, so N pages writing to it never re-render the pane).
    expect(registryRefs.size).toBe(1)
    // 1-based page numbers off 0-based virtual indexes — the off-by-one is the contract.
    expect(pageNumbers(container)).toEqual([1, 2])
    for (const p of pageProps) {
      expect(p.containerWidth).toBe(VIEW_W)
      expect(p.zoom).toBe(1)
    }
  })

  it('renders an error state instead of a blank pane when page 1 fails (#183)', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    docAFailsPageOne = true
    docs = { A: makeDoc('A'), B: makeDoc('B') }
    restoreLayout = installPdfLayout({ width: VIEW_W, height: VIEW_H })
    const { container } = renderReader(seededClient({}))

    await waitFor(() => expect(container.textContent).toContain('could not be read'))
    // The gate MUST stay shut: `fallback === null` is the only thing that clears
    // virtual-core's itemSizeCache across a swap (`index.js:601-605`), so "unblock
    // rendering by faking a fallback" is not an available fix.
    expect(container.querySelectorAll('[data-page-number]')).toHaveLength(0)
    expect(container.textContent).toContain('bad page tree')
    err.mockRestore()
  })
})

describe('PdfReader zoom persistence (pdf.view.v1)', () => {
  it('restores the persisted per-document zoom instead of resetting to fit (1)', async () => {
    const qc = seededClient({ A: { zoom: 1.8 } })
    const { container } = renderReader(qc)

    // Zoom is observed via the persisted write: had restore NOT applied, zoom would
    // start at the fit reset (1) and a single wheel-in would write 1.1; restored to
    // 1.8 it writes 1.8 × 1.1 ≈ 1.98.
    await zoomInOnce(container)

    const set = lastSet(mockApi)
    expect(set.key).toBe('pdf.view.v1')
    expect(set.value.A?.zoom).toBeCloseTo(1.98, 2)
  })

  it('persists the new zoom for the open doc AND merges (preserves) other docs', async () => {
    const qc = seededClient({ A: { zoom: 1.8 }, B: { zoom: 2.2 } })
    const { container } = renderReader(qc)

    await zoomInOnce(container)

    const set = lastSet(mockApi)
    // Object-form IPC payload (api.settings.set(k,v) → window.api.settings.set({key,value})).
    expect(set).toEqual({ key: 'pdf.view.v1', value: expect.any(Object) })
    expect(set.value.A?.zoom).toBeCloseTo(1.98, 2) // A updated
    expect(set.value.B?.zoom).toBe(2.2) // B preserved (merge, not clobber)
  })

  it('A→B→A swap restores the CURRENT-session zoom, not the stale boot value', async () => {
    // Boot snapshot: A at 1.8. This is the whole trap — useSessionSnapshot is
    // boot-initial only, so a naive `view[A].zoom` read would restore 1.8 on the
    // way back, silently losing the in-session change.
    const qc = seededClient({ A: { zoom: 1.8 } })
    const { container, rerender } = renderReader(qc)

    // A restored to 1.8, then zoomed in once → A's live session zoom ≈ 1.98.
    await zoomInOnce(container)
    expect(lastSet(mockApi).value.A?.zoom).toBeCloseTo(1.98, 2)

    // Swap to B (fresh doc ⇒ reset effect fires). B not persisted ⇒ fit (1).
    currentPdfId = 'B'
    rerender(
      <QueryClientProvider client={qc}>
        <PdfReader />
      </QueryClientProvider>,
    )
    await zoomInOnce(container) // B: 1 → 1.1

    // Swap BACK to A. The reset/restore effect must read A's CURRENT session zoom
    // (≈1.98, kept live via setQueryData), NOT the boot 1.8.
    currentPdfId = 'A'
    rerender(
      <QueryClientProvider client={qc}>
        <PdfReader />
      </QueryClientProvider>,
    )
    await zoomInOnce(container) // A: restored → restored × 1.1

    // 1.98 × 1.1 ≈ 2.178 (fix). A stale static-cache read would restore 1.8 and
    // write 1.98 here — this assertion is what makes the trap falsifiable.
    expect(lastSet(mockApi).value.A?.zoom).toBeCloseTo(2.178, 2)
  })

  /**
   * Quit flush (spec §Write-through): a zoom made within the 200ms debounce window then a
   * Cmd-Q must not be lost. `visibilitychange`→hidden flushes the pending write immediately.
   * Without the flush the debounced timer never fires (the window quit first) → write dropped.
   */
  it('flushes a pending zoom on visibilitychange→hidden (before the debounce elapses)', async () => {
    const qc = seededClient({ A: { zoom: 1.8 } })
    const { container } = renderReader(qc)
    // Zoom A but do NOT wait for the 200ms debounce — the disk write is still pending.
    await act(async () => {
      pageEl(container).dispatchEvent(ctrlWheelIn())
    })
    expect(mockApi.settings.set).not.toHaveBeenCalled() // still debounced, nothing written yet

    // Simulate quit: document hidden + visibilitychange → flush immediately.
    await act(async () => {
      Object.defineProperty(document, 'hidden', { value: true, configurable: true })
      document.dispatchEvent(new Event('visibilitychange'))
    })
    const set = lastSet(mockApi)
    expect(set.key).toBe('pdf.view.v1')
    expect(set.value.A?.zoom).toBeCloseTo(1.98, 2)
  })

  /**
   * Swap flush: a zoom on doc A, then a swap to B BEFORE the debounce fires. The persist
   * effect's [zoom,pdfId] cleanup clears the pending timer; the [pdfId] swap-flush must
   * commit A's zoom first so it isn't dropped by the swap (carry-forward from finding #3).
   */
  it('persists a pending zoom on doc-swap before the debounce (not dropped)', async () => {
    const qc = seededClient({ A: { zoom: 1.8 } })
    const { container, rerender } = renderReader(qc)
    // Zoom A but do NOT wait for the debounce — the write is pending.
    await act(async () => {
      pageEl(container).dispatchEvent(ctrlWheelIn())
    })
    expect(mockApi.settings.set).not.toHaveBeenCalled()

    // Swap to B before the 200ms debounce elapses.
    currentPdfId = 'B'
    await act(async () => {
      rerender(
        <QueryClientProvider client={qc}>
          <PdfReader />
        </QueryClientProvider>,
      )
    })
    const set = lastSet(mockApi)
    expect(set.key).toBe('pdf.view.v1')
    expect(set.value.A?.zoom).toBeCloseTo(1.98, 2) // A's pending zoom flushed on the swap
  })
})

describe('PdfReader anchor tracking (spec §4.5, §4.6)', () => {
  /**
   * The one test that pins Task 2.2b. It fails for THREE distinct regressions, each
   * of which was mutation-verified (see the task report):
   *
   * 1. `onScroll` not wired → `anchorRef` stays null → the zoom effect early-returns
   *    → scrollTop keeps its zoom-1 value, which reads as page ~273 at zoom 1.1.
   * 2. `virtualizer.measure()` dropped → `getMeasurements` is memoized on
   *    `[getMeasurementOptions(), itemSizeCacheVersion]` and `estimateSize` is in
   *    NEITHER (`virtual-core/dist/esm/index.js:560-588, 589-590`), so the new
   *    zoom's heights never reach the cache → same old-scale offset.
   * 3. `readAnchorItem` without its `getTotalSize()` → the B2 stale-cache bug.
   *
   * Asserting the RESULTING offset, not that `measure`/`scrollToOffset` were called:
   * every one of the three above still "calls measure".
   */
  it('re-anchors to the SAME page after a zoom step (not merely "measure was called")', async () => {
    restoreLayout = installPdfLayout({ width: VIEW_W, height: VIEW_H })
    restoreScrollHeight = installScrollHeight()
    const { container } = renderReader(seededClient({}))
    await waitFor(() => expect(pageNumbers(container).length).toBeGreaterThan(0))

    await scrollToPage(container, 300)
    // Guard the guard: without a real scrollHeight the clamp above would have
    // pinned this at 0 and everything below would be measuring nothing.
    expect(anchorAt(container, 1)).toEqual({ page: 300, fraction: 0 })

    await act(async () => {
      pageEl(container).dispatchEvent(ctrlWheelIn())
    })

    const after = anchorAt(container, ZOOM_STEP)
    expect(after.page).toBeGreaterThan(295)
    expect(after.page).toBeLessThan(305)
    // Tighter than the plan's ±5 window, and not brittle: every quantity here is an
    // integer (`cssH` is floored, `gap` is 12), so the arithmetic is exact. The exact
    // form is also the ONLY one that catches a dropped `align: 'start'` — the
    // `'auto'` default subtracts one viewport height (`index.js:941-945`), ~0.8 of a
    // page at this zoom, which hides inside the ±5 window. Spec §4.6.
    expect(after).toEqual({ page: 300, fraction: 0 })
  })

  /**
   * Corroboration at the DOM level: after the re-anchor the WINDOW follows, not just
   * `scrollTop`. Split from the test above because it needs an extra `scroll`
   * dispatch — happy-dom's `scrollTo` sets `scrollTop` and stops
   * (`Element.js:993-1011`), where a real browser fires `scroll`, and virtual-core's
   * range is computed from the offset that listener records, never from the DOM.
   */
  it('renders the re-anchored page after the browser echoes the programmatic scroll', async () => {
    restoreLayout = installPdfLayout({ width: VIEW_W, height: VIEW_H })
    restoreScrollHeight = installScrollHeight()
    const { container } = renderReader(seededClient({}))
    await waitFor(() => expect(pageNumbers(container).length).toBeGreaterThan(0))

    await scrollToPage(container, 300)
    expect(pageNumbers(container)).toContain(300) // pre-zoom window — guard the guard
    await act(async () => {
      pageEl(container).dispatchEvent(ctrlWheelIn())
    })
    await act(async () => {
      pageEl(container).dispatchEvent(new Event('scroll'))
    })

    expect(pageNumbers(container)).toContain(300)
    // overscan drops to 0 above fit (spec §4.4), so the zoomed window is page 300 alone.
    expect(pageNumbers(container)).toEqual([300])
  })
})
