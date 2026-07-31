import { afterEach, describe, expect, it, vi } from 'vitest'
import { installPdfLayout, stubPageRects } from '../../../../tests/pdf-layout'

/**
 * Tests for the test harness itself.
 *
 * Why a harness has its own tests: every component assertion in Batches 2-6 of
 * `docs/plans/v0.8-multipage-pdf.md` is gated on `containerWidth > 0`, which only
 * becomes true because of `installPdfLayout`. If the stubbed ResizeObserver ever
 * stops firing its callback, the reader renders nothing, every `queryAll(...)`
 * returns empty, and the suites go VACUOUSLY green rather than red. That failure
 * mode is invisible without these tests.
 *
 * @see docs/plans/v0.8-multipage-pdf.md §Task 1.0
 * @issue utof/linsae#154
 */
describe('installPdfLayout', () => {
  let restore: (() => void) | null = null

  afterEach(() => {
    restore?.()
    restore = null
    vi.restoreAllMocks()
  })

  it('starts from happy-dom reporting clientWidth 0 — the premise the harness exists to fix', () => {
    // PdfReader.test.tsx:8-11 documents that the v0.6 render effect "never runs here"
    // precisely because of this. If happy-dom ever gains layout, the harness is moot.
    expect(document.createElement('div').clientWidth).toBe(0)
  })

  it('reports the configured width and height on any element while installed', () => {
    restore = installPdfLayout({ width: 900, height: 1000 })
    const el = document.createElement('div')
    expect(el.clientWidth).toBe(900)
    expect(el.clientHeight).toBe(1000)
  })

  it('defaults to 900x1000 when no options are passed', () => {
    restore = installPdfLayout()
    const el = document.createElement('div')
    expect(el.clientWidth).toBe(900)
    expect(el.clientHeight).toBe(1000)
  })

  it('fires the ResizeObserver callback SYNCHRONOUSLY on observe, with the observed element', () => {
    // The load-bearing behaviour: PdfReader measures inside the RO callback, so a
    // no-op observer would leave containerWidth at 0 forever and silently void
    // every downstream assertion.
    restore = installPdfLayout()
    const el = document.createElement('div')
    const cb = vi.fn()
    new globalThis.ResizeObserver(cb).observe(el)
    expect(cb).toHaveBeenCalledTimes(1)
    expect(cb.mock.calls[0]?.[0]?.[0]?.target).toBe(el)
  })

  it('restores clientWidth and the original ResizeObserver, leaking nothing into other suites', () => {
    const originalRO = globalThis.ResizeObserver
    const undo = installPdfLayout({ width: 900 })
    expect(document.createElement('div').clientWidth).toBe(900)
    undo()
    expect(document.createElement('div').clientWidth).toBe(0)
    expect(globalThis.ResizeObserver).toBe(originalRO)
  })
})

describe('stubPageRects', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('stacks pages so page N starts at (N-1) * pageHeight', () => {
    stubPageRects(1000)
    const page = document.createElement('div')
    page.setAttribute('data-page-number', '3')
    expect(page.getBoundingClientRect().top).toBe(2000)
    expect(page.getBoundingClientRect().bottom).toBe(3000)
  })

  it('resolves the page from an ANCESTOR, so nested content inherits its page rect', () => {
    // Excerpt capture measures the page's contentEl, which is a child of the
    // [data-page-number] wrapper — closest() must climb to it.
    stubPageRects(1000)
    const page = document.createElement('div')
    page.setAttribute('data-page-number', '2')
    const content = document.createElement('div')
    page.appendChild(content)
    expect(content.getBoundingClientRect().top).toBe(1000)
  })

  it('treats an element outside any page as page 0, so it sorts above page 1', () => {
    stubPageRects(1000)
    expect(document.createElement('div').getBoundingClientRect().top).toBe(-1000)
  })
})
