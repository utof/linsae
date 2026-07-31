import { renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { computePdfRender } from './computePdfRender'
import { estimateHeight, usePdfPageDims } from './usePdfPageDims'

const DIMS = new Map([
  [1, { w: 612, h: 792 }],
  [7, { w: 792, h: 612 }],
]) // p7 landscape
// Deliberately DISTINCT from DIMS.get(1) (A4, not Letter). In production the
// fallback is page 1's dims, but if the fixture repeated those values then a buggy
// `dims.get(n) ?? dims.get(1)` would pass the fallback test just as well as the
// real `?? fallback`. Distinct numbers make the two implementations distinguishable.
const FB = { w: 595, h: 842 }

describe('estimateHeight', () => {
  it('preserves the page aspect ratio at the fitted width', () => {
    const h = estimateHeight(1, DIMS, FB, 900, 1)
    expect(h / 900).toBeCloseTo(792 / 612, 2)
  })
  it('fits a landscape page to the SAME width, so it is shorter', () => {
    expect(estimateHeight(7, DIMS, FB, 900, 1)).toBeLessThan(estimateHeight(1, DIMS, FB, 900, 1))
  })
  it('uses the FALLBACK dims for an unmeasured page, not a cached page-1 entry', () => {
    // Asserts against the fallback's own geometry, and explicitly NOT against page 1's,
    // so a `dims.get(n) ?? dims.get(1)` implementation fails here.
    expect(estimateHeight(400, DIMS, FB, 900, 1)).toBe(computePdfRender(900, 595, 842, 1, 1).cssH)
    expect(estimateHeight(400, DIMS, FB, 900, 1)).not.toBe(estimateHeight(1, DIMS, FB, 900, 1))
  })
  it('doubles with zoom 2, up to the single floor in computePdfRender', () => {
    // Not exactly 2x: computePdfRender floors cssH (computePdfRender.ts:85), and
    // floor(2x) - 2*floor(x) = floor(2*frac(x)). For this fixture frac is 0.7059,
    // so the answer is exactly 1 — asserted as an equality, not a range, so a
    // change in zoom handling fails loudly instead of sliding inside a window.
    //
    // This checks LINEARITY (zoom is applied once, not dropped or squared); it does
    // NOT discriminate the floating-point associativity trap, since a hand-rolled
    // floor(floor(h*fs)*zoom) would land inside any bound expressible here. The
    // next test is the one that catches that, by comparing against real cssH.
    expect(estimateHeight(1, DIMS, FB, 900, 2) - estimateHeight(1, DIMS, FB, 900, 1) * 2).toBe(1)
  })
  it('is byte-identical to the rendered canvas cssH (no FP drift)', () => {
    // guards the associativity trap: h*(fs*zoom) !== (h*fs)*zoom in floating point
    const { cssH } = computePdfRender(900, 612, 792, 2, 1.1)
    expect(estimateHeight(1, DIMS, FB, 900, 1.1)).toBe(cssH)
  })
  it('returns 0 before the container is measured (the boot gate handles this)', () => {
    expect(estimateHeight(1, DIMS, FB, 0, 1)).toBe(0)
  })
})

describe('usePdfPageDims (hook)', () => {
  const mkDoc = (id: string) => ({
    id,
    getPage: vi.fn(async (n: number) => ({
      getViewport: () => ({ width: 612, height: n === 7 ? 500 : 792 }),
    })),
  })

  it('seeds the fallback from page 1 only', async () => {
    const doc = mkDoc('A')
    const { result } = renderHook(() => usePdfPageDims(doc as never))
    await waitFor(() => expect(result.current.fallback).toEqual({ w: 612, h: 792 }))
    expect(doc.getPage).toHaveBeenCalledTimes(1) // NOT once per page — the 500-page cost model
  })

  it('coalesces concurrent ensureDims for the same page into one getPage', async () => {
    const doc = mkDoc('A')
    const { result } = renderHook(() => usePdfPageDims(doc as never))
    await waitFor(() => expect(result.current.fallback).not.toBeNull())
    await Promise.all([result.current.ensureDims(5), result.current.ensureDims(5)])
    expect(doc.getPage.mock.calls.filter((c) => c[0] === 5)).toHaveLength(1)
  })

  it('returns null for an already-cached page (so the caller skips a redundant resizeItem)', async () => {
    const doc = mkDoc('A')
    const { result } = renderHook(() => usePdfPageDims(doc as never))
    await waitFor(() => expect(result.current.fallback).not.toBeNull())
    expect(await result.current.ensureDims(5)).not.toBeNull()
    expect(await result.current.ensureDims(5)).toBeNull()
  })

  it('DROPS an in-flight resolution from the previous document on swap', async () => {
    // M3: without a generation guard, doc A's page-300 dims land in doc B's map
    const docA = mkDoc('A')
    let release!: () => void
    docA.getPage = vi.fn((n: number) =>
      n === 1
        ? Promise.resolve({ getViewport: () => ({ width: 612, height: 792 }) })
        : new Promise((res) => {
            release = () => res({ getViewport: () => ({ width: 111, height: 111 }) })
          }),
    )
    const { result, rerender } = renderHook(({ d }) => usePdfPageDims(d as never), {
      initialProps: { d: docA },
    })
    await waitFor(() => expect(result.current.fallback).not.toBeNull())
    const pending = result.current.ensureDims(300)
    rerender({ d: mkDoc('B') })
    release()
    await pending
    expect(result.current.dimsRef.current.get(300)).toBeUndefined()
  })

  it('returns the REQUESTED page dims, not page 1s (catches a transposed set)', async () => {
    // The fixture makes page 7 a different height (500 vs 792) precisely so this is
    // checkable; without this assertion a set(n, {w, h: w}) transposition passes.
    const doc = mkDoc('A')
    const { result } = renderHook(() => usePdfPageDims(doc as never))
    await waitFor(() => expect(result.current.fallback).not.toBeNull())
    expect(await result.current.ensureDims(7)).toEqual({ w: 612, h: 500 })
  })

  it('RESETS fallback and the dims map on swap — the leak the hook comment forbids', async () => {
    // usePdfPageDims.ts warns that keeping `fallback` truthy across a swap would leak
    // doc A's pixel heights into doc B, because `fallback === null` is the only thing
    // holding the reader's ready gate (and thus virtual-core's itemSizeCache reset).
    // Nothing tested that contract, so the exact "optimization" it forbids was free.
    const docA = mkDoc('A')
    const { result, rerender } = renderHook(({ d }) => usePdfPageDims(d as never), {
      initialProps: { d: docA },
    })
    await waitFor(() => expect(result.current.fallback).not.toBeNull())
    await result.current.ensureDims(7)
    expect(result.current.dimsRef.current.get(7)).toBeDefined()

    rerender({ d: mkDoc('B') })
    expect(result.current.fallback).toBeNull() // gate re-closes synchronously
    expect(result.current.dimsRef.current.get(7)).toBeUndefined() // doc A's heights gone
    await waitFor(() => expect(result.current.fallback).not.toBeNull()) // re-seeds from B
  })

  it('does not clear the NEXT documents in-flight marker when a stale request settles', async () => {
    // The finally must delete from the set it added to. Re-reading inFlightRef.current
    // would clear doc B's marker for a page still airborne, letting a duplicate
    // getPage through and silently defeating the coalescing guard.
    const docA = mkDoc('A')
    let releaseA!: () => void
    docA.getPage = vi.fn((n: number) =>
      n === 1
        ? Promise.resolve({ getViewport: () => ({ width: 612, height: 792 }) })
        : new Promise((res) => {
            releaseA = () => res({ getViewport: () => ({ width: 111, height: 111 }) })
          }),
    )
    const docB = mkDoc('B')
    let releaseB!: () => void
    docB.getPage = vi.fn((n: number) =>
      n === 1
        ? Promise.resolve({ getViewport: () => ({ width: 612, height: 792 }) })
        : new Promise((res) => {
            releaseB = () => res({ getViewport: () => ({ width: 612, height: 792 }) })
          }),
    )
    const { result, rerender } = renderHook(({ d }) => usePdfPageDims(d as never), {
      initialProps: { d: docA },
    })
    await waitFor(() => expect(result.current.fallback).not.toBeNull())
    const staleA = result.current.ensureDims(5) // doc A, page 5 — never resolves yet

    rerender({ d: docB })
    await waitFor(() => expect(result.current.fallback).not.toBeNull())
    void result.current.ensureDims(5) // doc B, page 5 — now in flight
    releaseA() // A's stale request settles and runs its finally
    await staleA

    void result.current.ensureDims(5) // must be coalesced away, not re-issued
    expect(docB.getPage.mock.calls.filter((c) => c[0] === 5)).toHaveLength(1)
    releaseB()
  })
})
