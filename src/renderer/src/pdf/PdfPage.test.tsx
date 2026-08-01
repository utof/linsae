import { act, render, waitFor } from '@testing-library/react'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { StrictMode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { capBitmapPixels } from './capBitmapPixels'
import { computePdfRender } from './computePdfRender'

// --- Mocks -----------------------------------------------------------------
// pdfjs-dist is value-imported for `TextLayer` only. Stubbing it keeps the import
// cheap AND makes the overlay observable: `tl.render` is swappable per test so a
// test can hold the text layer unresolved and prove registration waits for it.
const tl = vi.hoisted(() => ({
  ctorArgs: [] as Array<{ container: HTMLElement; viewport: { scale: number } }>,
  render: () => Promise.resolve(),
  onCancel: () => {},
}))

vi.mock('pdfjs-dist', () => ({
  TextLayer: class {
    constructor(args: { container: HTMLElement; viewport: { scale: number } }) {
      tl.ctorArgs.push(args)
    }
    render(): Promise<void> {
      return tl.render()
    }
    cancel(): void {
      tl.onCancel()
    }
  },
}))

import { type PageRegistryEntry, PdfPage } from './PdfPage'

const CONTAINER_WIDTH = 900
const PAGE_NUMBER = 3

/**
 * The object every `getViewport()` call returns, at ANY scale. `scale` is
 * deliberately 3.5 — a value the component can only produce by reading
 * `viewport.scale`, since it equals neither the fit scale (900/612 ≈ 1.47), the
 * dpr (1 or 2 here), nor the capped effective dpr (≈0.8 in the cap test). That is
 * what makes the `--total-scale-factor` assertion falsifiable.
 */
const VIEWPORT = { width: 612, height: 792, scale: 3.5, rotation: 0 }

interface PageMock {
  pageNumber: number
  getViewport: (o: { scale: number }) => { width: number; height: number; scale: number }
  render: ReturnType<typeof vi.fn>
  streamTextContent: () => object
  cleanup: ReturnType<typeof vi.fn>
}

function makePage(overrides: Partial<PageMock> = {}): PageMock {
  return {
    pageNumber: PAGE_NUMBER,
    getViewport: () => VIEWPORT,
    render: vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() })),
    streamTextContent: () => ({}),
    cleanup: vi.fn(),
    ...overrides,
  }
}

const docReturning = (page: PageMock): PDFDocumentProxy =>
  ({ numPages: 10, getPage: vi.fn(async () => page) }) as unknown as PDFDocumentProxy

function baseProps(page: PageMock) {
  return {
    doc: docReturning(page),
    pageNumber: PAGE_NUMBER,
    containerWidth: CONTAINER_WIDTH,
    zoom: 1,
    registryRef: { current: new Map<number, PageRegistryEntry>() },
    measureRef: vi.fn(),
  }
}

/** The rendered CSS box for this fixture at a given zoom — the cap's real input. */
function cssBox(zoom: number, dpr = 1): [number, number] {
  const dims = computePdfRender(CONTAINER_WIDTH, VIEWPORT.width, VIEWPORT.height, dpr, zoom)
  return [dims.cssW, dims.cssH]
}

/**
 * Record every ASSIGNMENT to `canvas.width` / `canvas.height` by shadowing the
 * prototype accessors on one element.
 *
 * Why not a MutationObserver (the shape the plan sketched): its callback is
 * microtask-queued and reads the CURRENT value, so a `width = 0; width = N` pair
 * inside one task has already settled on N by the time it runs — the observer
 * cannot see the very flash it exists to catch. Shadowing the accessor sees each
 * write synchronously.
 */
function recordBackingStoreWrites(canvas: HTMLCanvasElement): {
  width: number[]
  height: number[]
} {
  const writes = { width: [] as number[], height: [] as number[] }
  for (const key of ['width', 'height'] as const) {
    const desc = Object.getOwnPropertyDescriptor(
      HTMLCanvasElement.prototype,
      key,
    ) as PropertyDescriptor
    Object.defineProperty(canvas, key, {
      configurable: true,
      get: () => desc.get?.call(canvas) as number,
      set: (v: number) => {
        writes[key].push(v)
        desc.set?.call(canvas, v)
      },
    })
  }
  return writes
}

const canvasOf = (c: HTMLElement) => c.querySelector('canvas') as HTMLCanvasElement
const textLayerOf = (c: HTMLElement) => c.querySelector('.textLayer') as HTMLElement

beforeEach(() => {
  tl.ctorArgs.length = 0
  tl.render = () => Promise.resolve()
  tl.onCancel = () => {}
  // happy-dom reports 1; the cap test raises it and this resets it for everyone else.
  Object.defineProperty(window, 'devicePixelRatio', { value: 1, configurable: true })
})

describe('PdfPage', () => {
  it('cancels the render task BEFORE page.cleanup() on unmount', async () => {
    const order: string[] = []
    const cancel = vi.fn(() => order.push('cancel'))
    const cleanup = vi.fn(() => order.push('cleanup'))
    const page = makePage({
      render: vi.fn(() => ({ promise: Promise.resolve(), cancel })),
      cleanup,
    })
    const props = baseProps(page)
    const { unmount } = render(<PdfPage {...props} doc={docReturning(page)} />)
    await waitFor(() => expect(props.registryRef.current.has(PAGE_NUMBER)).toBe(true))

    unmount()

    // PDFPageProxy.#tryCleanup() no-ops while renderTasks.size > 0
    // (pdfjs-dist@6.0.227 build/pdf.mjs:15701-15717, guard at :15709-15711), and the
    // render task's completion handler calls it again (:15535) — so the wrong order
    // is a deferred release, which is exactly what book-scale memory cannot afford.
    expect(order).toEqual(['cancel', 'cleanup'])
  })

  it('cancels the text layer between the render task and page.cleanup()', async () => {
    const order: string[] = []
    tl.onCancel = () => order.push('textLayer.cancel')
    const page = makePage({
      render: vi.fn(() => ({ promise: Promise.resolve(), cancel: () => order.push('cancel') })),
      cleanup: vi.fn(() => order.push('cleanup')),
    })
    const props = baseProps(page)
    const { unmount } = render(<PdfPage {...props} />)
    await waitFor(() => expect(props.registryRef.current.has(PAGE_NUMBER)).toBe(true))

    unmount()

    expect(order).toEqual(['cancel', 'textLayer.cancel', 'cleanup'])
  })

  it('does NOT zero the canvas backing store on a scale change (no white flash)', async () => {
    const page = makePage()
    const props = baseProps(page)
    const { rerender, container } = render(<PdfPage {...props} zoom={1} />)
    // NOT `canvas.width > 0`: happy-dom seeds the HTML default 300×150, so that
    // gate passes before anything renders. The registry entry is the real signal.
    await waitFor(() => expect(props.registryRef.current.has(PAGE_NUMBER)).toBe(true))
    const canvas = canvasOf(container)
    const atFit = canvas.width
    expect(atFit).toBe(capBitmapPixels(...cssBox(1), 1).bitmapW)

    const writes = recordBackingStoreWrites(canvas)
    rerender(<PdfPage {...props} zoom={2} />)
    await waitFor(() => expect(canvas.width).not.toBe(atFit))

    expect(canvas.width).toBeGreaterThan(atFit)
    // Assigning ANY value to canvas.width clears the bitmap, so the assertion is on
    // the write log, not on the settled value: exactly one write, straight to the
    // new size, with no zero in between.
    expect(writes.width).not.toContain(0)
    expect(writes.height).not.toContain(0)
    expect(writes.width).toEqual([capBitmapPixels(...cssBox(2), 1).bitmapW])
  })

  it('does not deregister or clean up the page across a scale change', async () => {
    const page = makePage()
    const props = baseProps(page)
    const { rerender } = render(<PdfPage {...props} zoom={1} />)
    await waitFor(() => expect(props.registryRef.current.has(PAGE_NUMBER)).toBe(true))
    const before = props.registryRef.current.get(PAGE_NUMBER)

    rerender(<PdfPage {...props} zoom={2} />)

    // No window in which excerpt capture would find nothing for this page.
    expect(props.registryRef.current.has(PAGE_NUMBER)).toBe(true)
    expect(page.cleanup).not.toHaveBeenCalled()
    await waitFor(() => expect(props.registryRef.current.get(PAGE_NUMBER)).not.toBe(before))
  })

  it('zeroes the canvas backing store on unmount', async () => {
    const page = makePage()
    const props = baseProps(page)
    const { container, unmount } = render(<PdfPage {...props} />)
    await waitFor(() => expect(props.registryRef.current.has(PAGE_NUMBER)).toBe(true))
    const canvas = canvasOf(container)
    const writes = recordBackingStoreWrites(canvas)
    expect(canvas.width).toBeGreaterThan(0)

    unmount()

    // Releasing the backing store is what makes 500 pages survivable — a windowed-out
    // page must not keep tens of MB alive behind a detached element.
    expect(writes.width).toEqual([0])
    expect(writes.height).toEqual([0])
    expect(canvas.width).toBe(0)
    expect(canvas.height).toBe(0)
    expect(props.registryRef.current.has(PAGE_NUMBER)).toBe(false)
  })

  it('registers {page, viewport, contentEl} after the text layer resolves', async () => {
    let releaseTextLayer!: () => void
    tl.render = () =>
      new Promise<void>((resolve) => {
        releaseTextLayer = resolve
      })
    const page = makePage()
    const props = baseProps(page)
    const { container } = render(<PdfPage {...props} />)

    // The raster finished (the TextLayer was constructed) but the overlay has not:
    // registering here would hand excerpt capture a page whose selectable text does
    // not exist yet.
    await waitFor(() => expect(tl.ctorArgs).toHaveLength(1))
    expect(props.registryRef.current.has(PAGE_NUMBER)).toBe(false)

    await act(async () => releaseTextLayer())
    await waitFor(() => expect(props.registryRef.current.has(PAGE_NUMBER)).toBe(true))

    const entry = props.registryRef.current.get(PAGE_NUMBER) as PageRegistryEntry
    expect(entry.page as unknown).toBe(page)
    expect(entry.viewport as unknown).toBe(VIEWPORT)
    // The CONTENT box (canvas + overlay wrapper), not the outer measured wrapper:
    // its top-left is the page's coordinate origin under scroll and zoom.
    expect(entry.contentEl).toBe(canvasOf(container).parentElement)
    expect(tl.ctorArgs[0]?.container).toBe(textLayerOf(container))
  })

  it('sets --total-scale-factor from viewport.scale, NEVER the capped dpr', async () => {
    Object.defineProperty(window, 'devicePixelRatio', { value: 2, configurable: true })
    const page = makePage()
    const props = baseProps(page)
    const { container } = render(<PdfPage {...props} zoom={5} />)
    await waitFor(() => expect(props.registryRef.current.has(PAGE_NUMBER)).toBe(true))

    const [cssW, cssH] = cssBox(5, 2)
    const capped = capBitmapPixels(cssW, cssH, 2)
    // Guard the guard: if the cap were NOT engaged this test would prove nothing.
    expect(capped.bitmapW).toBeLessThan(cssW * 2)
    expect(canvasOf(container).width).toBe(capped.bitmapW)
    expect(page.render).toHaveBeenCalledWith(
      expect.objectContaining({ transform: capped.transform }),
    )

    // if the overlay followed the bitmap cap, selectable text would drift at high zoom
    const textLayerDiv = textLayerOf(container)
    expect(textLayerDiv.style.getPropertyValue('--total-scale-factor')).toBe(String(VIEWPORT.scale))
    expect(textLayerDiv.style.getPropertyValue('--scale-factor')).toBe(String(VIEWPORT.scale))
  })

  it('bails loudly instead of rasterizing a NaN-sized canvas for a zero-width page', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const page = makePage({ getViewport: () => ({ width: 0, height: 792, scale: 3.5 }) })
    const props = baseProps(page)
    const { container } = render(<PdfPage {...props} />)

    await waitFor(() => expect(err).toHaveBeenCalled())
    // computePdfRender(cw, 0, h, …) yields fitScale Infinity ⇒ cssW = floor(0 * Infinity)
    // = NaN, capBitmapPixels passes NaN through (its `area > 0` test is false for NaN),
    // and `canvas.width = NaN` coerces to 0 per WebIDL — a silently blank page. A 0 here
    // is therefore the fingerprint of the un-guarded bug, not an incidental value.
    expect(canvasOf(container).width).not.toBe(0)
    expect(page.render).not.toHaveBeenCalled()
    expect(props.registryRef.current.has(PAGE_NUMBER)).toBe(false)
    err.mockRestore()
  })

  it('tags the wrapper for the virtualizer and hands it to measureElement', () => {
    const props = baseProps(makePage())
    const { container } = render(<PdfPage {...props} />)

    const wrapper = container.firstElementChild as HTMLElement
    // data-index is the virtualizer's `indexAttribute` default (0-based); the page
    // number is 1-based, so the off-by-one here is the contract, not a bug.
    expect(wrapper.getAttribute('data-index')).toBe(String(PAGE_NUMBER - 1))
    expect(wrapper.getAttribute('data-page-number')).toBe(String(PAGE_NUMBER))
    // Passed as the `ref` itself — anything else and `indexFromElement` never runs
    // (`virtual-core/index.js:802-825`).
    expect(props.measureRef).toHaveBeenCalledWith(wrapper)
  })

  it('survives a StrictMode double-invoke with one live raster and one registration', async () => {
    const page = makePage()
    const props = baseProps(page)
    const { container } = render(
      <StrictMode>
        <PdfPage {...props} />
      </StrictMode>,
    )
    await waitFor(() => expect(props.registryRef.current.has(PAGE_NUMBER)).toBe(true))

    // The simulated unmount runs the FULL teardown (including `canvas.width = 0`)
    // between the two mounts. If the surviving run did not re-size and re-rasterize,
    // the page would be permanently blank in dev — and `main.tsx:33` ships StrictMode.
    expect(canvasOf(container).width).toBe(capBitmapPixels(...cssBox(1), 1).bitmapW)
    // Exactly one text layer: the discarded run must bail on its `cancelled` guard
    // before constructing a second overlay into the same container.
    expect(tl.ctorArgs).toHaveLength(1)
    expect(textLayerOf(container).style.getPropertyValue('--total-scale-factor')).toBe(
      String(VIEWPORT.scale),
    )
  })

  it('renders nothing until the container has been measured', () => {
    const page = makePage()
    const props = baseProps(page)
    render(<PdfPage {...props} containerWidth={0} />)

    // containerWidth 0 ⇒ fitScale 0 ⇒ a zero-size canvas; the reader's boot gate
    // should prevent this, but the leaf must not rasterize garbage if it slips.
    expect(props.doc.getPage).not.toHaveBeenCalled()
  })
})
