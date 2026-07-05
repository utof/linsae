import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { installMockApi, type MockApi } from '../../../../tests/setup'
import type { SessionSnapshot } from '../persistence/keys'

// --- Mocks -----------------------------------------------------------------
// PdfReader value-imports `{ TextLayer }` from pdfjs-dist purely for the render
// effect (which never runs here: happy-dom reports clientWidth 0 ⇒ containerWidth
// stays 0 ⇒ the effect early-returns). Stub the heavy module so the import is cheap.
vi.mock('pdfjs-dist', () => ({ TextLayer: class {} }))

// Controllable open-pdf id. The reset-on-swap effect keys on `doc` reference
// identity, so we hand out a DISTINCT object per id (swapping the id ⇒ a new
// `doc` ⇒ the reset/restore effect fires).
let currentPdfId: string | null = 'A'
vi.mock('./usePdfOpenId', () => ({
  usePdfOpenId: () => currentPdfId,
  useOpenPdf: () => async () => {},
}))

const docs: Record<string, { id: string }> = { A: { id: 'A' }, B: { id: 'B' } }
vi.mock('./usePdfDocument', () => ({
  usePdfDocument: (id: string | null) => ({ data: id ? docs[id] : undefined }),
}))

// The excerpt-capture wiring is irrelevant to zoom persistence; no-op it.
vi.mock('./useExcerptCapture', () => ({ useExcerptCapture: () => {} }))

import { PdfReader } from './PdfReader'

// The persist effect debounces the disk write; wait a hair past it before asserting.
const DEBOUNCE_WAIT_MS = 320

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

let mockApi: MockApi
beforeEach(() => {
  currentPdfId = 'A'
  mockApi = installMockApi()
  // Each test starts foreground; the quit-flush test flips this and resets it.
  Object.defineProperty(document, 'hidden', { value: false, configurable: true })
})

describe('PdfReader zoom persistence (pdf.view.v1)', () => {
  it('restores the persisted per-document zoom instead of resetting to fit (1)', async () => {
    const qc = seededClient({ A: { zoom: 1.8 } })
    const { container } = render(
      <QueryClientProvider client={qc}>
        <PdfReader />
      </QueryClientProvider>,
    )

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
    const { container } = render(
      <QueryClientProvider client={qc}>
        <PdfReader />
      </QueryClientProvider>,
    )

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
    const { container, rerender } = render(
      <QueryClientProvider client={qc}>
        <PdfReader />
      </QueryClientProvider>,
    )

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
    const { container } = render(
      <QueryClientProvider client={qc}>
        <PdfReader />
      </QueryClientProvider>,
    )
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
    const { container, rerender } = render(
      <QueryClientProvider client={qc}>
        <PdfReader />
      </QueryClientProvider>,
    )
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
