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
      this.cb([{ target: el } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver)
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
 * Give every `[data-page-number]` element a non-zero rect, so excerpt-capture's
 * page resolution and rect filtering have real geometry to work against.
 * `pageHeight` must match what `estimateHeight` yields for the mocked dims.
 */
export function stubPageRects(pageHeight: number, width = 900): void {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
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
}
