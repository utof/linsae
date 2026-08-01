import { vi } from 'vitest'

/**
 * Fake enough layout for the virtualized PDF reader to run under happy-dom.
 *
 * Why this exists: happy-dom performs no layout — `clientWidth` is 0 and
 * `getBoundingClientRect()` is zeroed (memory/progress.md §Load-bearing facts).
 * The v0.6 PdfReader suite RELIED on that (`PdfReader.test.tsx:8-11`: the render
 * effect "never runs here"). v0.8 gates rendering on `containerWidth > 0`, so
 * without this helper the reader renders nothing and every assertion is vacuous.
 *
 * Call in `beforeEach`; the returned fn restores the originals.
 *
 * @see docs/plans/v0.8-multipage-pdf.md §Task 1.0
 */
export function installPdfLayout(opts: { width?: number; height?: number } = {}): () => void {
  const width = opts.width ?? 900
  const height = opts.height ?? 1000
  // HTMLElement.prototype, NOT Element.prototype: happy-dom defines the clientWidth/
  // clientHeight accessors on HTMLElement (verified by probe, 2026-08-01). Patching
  // Element.prototype silently no-ops — HTMLElement's own accessor shadows it for
  // every HTML element, so the boot gate would never open and every Batch 2-6
  // assertion would run against an empty tree. `pdf-layout.test.ts` guards this.
  const protoClientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')
  const protoClientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight')
  const origRO = globalThis.ResizeObserver

  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get: () => width,
  })
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get: () => height,
  })

  // Synchronous, single-shot ResizeObserver: PdfReader measures in the RO callback,
  // so a no-op observer would leave containerWidth at 0 forever.
  globalThis.ResizeObserver = class {
    constructor(private cb: ResizeObserverCallback) {}
    observe(el: Element) {
      // contentRect/borderBoxSize are populated, not just `target`: a real RO entry
      // carries them, and PdfReader measuring via `entry.contentRect.width` is at
      // least as idiomatic as `el.clientWidth`. With a target-only entry the former
      // throws, so the harness would silently dictate the consumer's implementation.
      const entry = {
        target: el,
        contentRect: { width, height, top: 0, left: 0, bottom: height, right: width, x: 0, y: 0 },
        borderBoxSize: [{ inlineSize: width, blockSize: height }],
        contentBoxSize: [{ inlineSize: width, blockSize: height }],
      } as unknown as ResizeObserverEntry
      this.cb([entry], this as unknown as ResizeObserver)
    }
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver

  return () => {
    if (protoClientWidth)
      Object.defineProperty(HTMLElement.prototype, 'clientWidth', protoClientWidth)
    if (protoClientHeight)
      Object.defineProperty(HTMLElement.prototype, 'clientHeight', protoClientHeight)
    globalThis.ResizeObserver = origRO
  }
}

/**
 * Report a scroll container's `scrollHeight` as its first child's styled height.
 *
 * Why this is required for ANY test that scrolls the virtualized reader: happy-dom
 * hardcodes `scrollHeight` to 0 (`Element.js:133-135`), and virtual-core clamps every
 * programmatic scroll to `getMaxScrollOffset() = scrollHeight - clientHeight`. Under
 * `installPdfLayout`'s `clientHeight` of 1000 that maximum is **-1000**, so
 * `scrollToOffset(anything)` silently lands at 0 and every assertion downstream
 * measures nothing while still looking green.
 *
 * Reading the first child is not arbitrary: the reader's spacer is that child and its
 * styled height IS `virtualizer.getTotalSize()`, so the clamp stays truthful and
 * tracks zoom automatically.
 *
 * Defined on `Element.prototype`, unlike `installPdfLayout`'s `clientWidth`/
 * `clientHeight` which happy-dom puts on `HTMLElement.prototype` — the asymmetry is
 * happy-dom's, not ours.
 *
 * Returns a restore fn; call it in `afterEach`.
 *
 * @see docs/plans/v0.8-multipage-pdf.md §Task 2.2b
 * @issue utof/linsae#154
 */
export function installScrollHeight(): () => void {
  const orig = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollHeight')
  Object.defineProperty(Element.prototype, 'scrollHeight', {
    configurable: true,
    get(this: Element) {
      const child = this.firstElementChild as HTMLElement | null
      return child ? Number.parseFloat(child.style.height || '0') : 0
    },
  })
  return () => {
    if (orig) Object.defineProperty(Element.prototype, 'scrollHeight', orig)
  }
}

/**
 * Give every `[data-page-number]` element a non-zero rect, so excerpt-capture's
 * page resolution and rect filtering have real geometry to work against.
 * `pageHeight` must match what `estimateHeight` yields for the mocked dims.
 *
 * Returns a restore fn, mirroring `installPdfLayout`. Why it must be called:
 * `vi.spyOn` replaces the prototype method, the global afterEach in
 * `tests/setup.tsx:250` runs `vi.clearAllMocks()` (which clears CALLS, not
 * implementations) rather than `restoreAllMocks()`, and the renderer project sets
 * `isolate: false` (`vitest.config.ts:35`) so one happy-dom context is shared by
 * every file in a worker. Without restoring, a stubbed `getBoundingClientRect`
 * leaks into unrelated later files and fails them in confusing places.
 *
 * @see docs/plans/v0.8-multipage-pdf.md §Task 1.0
 * @issue utof/linsae#154
 */
export function stubPageRects(pageHeight: number, width = 900): () => void {
  const spy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    const n = Number(this.closest('[data-page-number]')?.getAttribute('data-page-number') ?? 0)
    const top = (n - 1) * pageHeight
    return {
      x: 0,
      y: top,
      top,
      bottom: top + pageHeight,
      left: 0,
      right: width,
      width,
      height: pageHeight,
      toJSON: () => ({}),
    } as DOMRect
  })
  return () => spy.mockRestore()
}
