import type { PDFDocumentProxy } from 'pdfjs-dist'
import { useCallback, useEffect, useRef, useState } from 'react'
import { computePdfRender } from './computePdfRender'

/** Unscaled (scale-1) viewport dimensions of one page — scale-INDEPENDENT. */
export interface PageDims {
  w: number
  h: number
}

/**
 * Fit-to-width height of a page at the current container width and zoom — the
 * single source of truth for the virtualizer's `estimateSize`.
 *
 * Delegates to `computePdfRender` so the estimate is byte-identical to the
 * rendered canvas's `cssH` BY CONSTRUCTION. Hand-rolling `h * (cw/w) * zoom`
 * associates as `(h·fs)·zoom` whereas `computePdfRender` computes
 * `scale = fs*zoom; floor(h*scale)`; floating-point multiplication is
 * non-associative, so the two can differ by a whole pixel after flooring — and a
 * disagreement between estimated and rendered height is exactly what makes a
 * virtualized list drift. `dpr` is irrelevant to `cssH`, so 1 is passed.
 *
 * `fitScale` is per page, so a landscape page among portrait pages fits the same
 * width and is simply shorter. The page wrapper must carry NO border/padding/
 * shadow — inter-page separation comes from the virtualizer's `gap` option, which
 * is folded into item `start`, not `size` (`virtual-core/index.js:648,682-685`).
 *
 * @see docs/specs/v0.8-multipage-pdf.md §4.2
 */
export function estimateHeight(
  pageNumber: number,
  dims: ReadonlyMap<number, PageDims>,
  fallback: PageDims,
  containerWidth: number,
  zoom: number,
): number {
  const d = dims.get(pageNumber) ?? fallback
  if (d.w <= 0 || containerWidth <= 0) return 0
  return computePdfRender(containerWidth, d.w, d.h, 1, zoom).cssH
}

/**
 * Owns the per-document map of UNSCALED page dimensions.
 *
 * Cost model: resolving page 1 alone at open is what makes a 500-page document
 * cheap to open — every other height is arithmetic until needed. Dims are
 * scale-free, so they survive every zoom and dock resize; the virtualizer's own
 * measurement cache does not (`measure()` clears it).
 *
 * REF-backed: mutated by N page children, and a state-backed map would re-render
 * (and re-bind the excerpt listener) on every scroll. **Mutating it does NOT
 * invalidate the virtualizer** — callers route new information through
 * `virtualizer.resizeItem`. @see docs/specs/v0.8-multipage-pdf.md §4.2.1
 *
 * NOTE: `fallback === null` is what holds the reader's `ready` gate false across a
 * document swap, and that gate (`enabled: false`) is the ONLY thing that clears the
 * previous document's `itemSizeCache` (`virtual-core/index.js:601-605`). Do not
 * "optimize" it to stay truthy across swaps — doc A's pixel heights would leak into doc B.
 *
 * @see docs/specs/v0.8-multipage-pdf.md §4.2
 * @issue utof/linsae#154
 */
export function usePdfPageDims(doc: PDFDocumentProxy | null | undefined) {
  const dimsRef = useRef<Map<number, PageDims>>(new Map())
  const [fallback, setFallback] = useState<PageDims | null>(null)
  const inFlightRef = useRef<Set<number>>(new Set())
  // Bumped on every document change. `ensureDims` captures it before awaiting and
  // discards its result if it changed — otherwise a getPage still in flight against
  // doc A writes A's dimensions into B's freshly-created map (the A→B→A swap path is
  // a tested one: PdfReader.test.tsx:135).
  const genRef = useRef(0)

  useEffect(() => {
    genRef.current += 1
    const gen = genRef.current
    dimsRef.current = new Map()
    inFlightRef.current = new Set()
    setFallback(null)
    if (!doc) return
    void doc
      .getPage(1)
      .then((p) => {
        if (genRef.current !== gen) return
        const v = p.getViewport({ scale: 1 })
        const d = { w: v.width, h: v.height }
        dimsRef.current.set(1, d)
        setFallback(d)
      })
      .catch(() => {})
  }, [doc])

  /**
   * Resolve one page's dims unless already known or in flight.
   * Returns the dims when NEWLY learned, else null — a non-null result is the
   * caller's signal to call `virtualizer.resizeItem` (spec §4.2.1 path 1). Null for
   * an already-cached page is correct, not a missed update: a cached page is already
   * sized correctly, and after `measure()` `estimateSize` re-derives it exactly.
   */
  const ensureDims = useCallback(
    async (pageNumber: number): Promise<PageDims | null> => {
      if (!doc) return null
      if (dimsRef.current.has(pageNumber) || inFlightRef.current.has(pageNumber)) return null
      const gen = genRef.current
      inFlightRef.current.add(pageNumber)
      try {
        const p = await doc.getPage(pageNumber)
        if (genRef.current !== gen) return null // document swapped mid-flight — discard
        const v = p.getViewport({ scale: 1 })
        const d = { w: v.width, h: v.height }
        dimsRef.current.set(pageNumber, d)
        return d
      } catch {
        return null
      } finally {
        inFlightRef.current.delete(pageNumber)
      }
    },
    [doc],
  )

  return { dimsRef, fallback, ensureDims }
}
