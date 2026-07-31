import { renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { computePdfRender } from './computePdfRender'
import { estimateHeight, usePdfPageDims } from './usePdfPageDims'

const DIMS = new Map([
  [1, { w: 612, h: 792 }],
  [7, { w: 792, h: 612 }],
]) // p7 landscape
const FB = { w: 612, h: 792 }

describe('estimateHeight', () => {
  it('preserves the page aspect ratio at the fitted width', () => {
    const h = estimateHeight(1, DIMS, FB, 900, 1)
    expect(h / 900).toBeCloseTo(792 / 612, 2)
  })
  it('fits a landscape page to the SAME width, so it is shorter', () => {
    expect(estimateHeight(7, DIMS, FB, 900, 1)).toBeLessThan(estimateHeight(1, DIMS, FB, 900, 1))
  })
  it('falls back to the page-1 estimate for an unmeasured page', () => {
    expect(estimateHeight(400, DIMS, FB, 900, 1)).toBe(estimateHeight(1, DIMS, FB, 900, 1))
  })
  it('doubles with zoom 2, up to the single floor in computePdfRender', () => {
    // Not exactly 2x: computePdfRender floors cssH (computePdfRender.ts:85), and
    // floor(2x) - 2*floor(x) = floor(2*frac(x)) is 0 or 1. Here frac is 0.7059, so
    // it is 1. Tolerance 1 is the exact bound, not slop — a wider window would hide
    // genuine estimate-vs-render drift, which is the bug class this file guards.
    const doubled = estimateHeight(1, DIMS, FB, 900, 1) * 2
    const actual = estimateHeight(1, DIMS, FB, 900, 2)
    expect(actual - doubled).toBeGreaterThanOrEqual(0)
    expect(actual - doubled).toBeLessThanOrEqual(1)
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
})
