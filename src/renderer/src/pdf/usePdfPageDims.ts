import type { RefObject } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { computePdfRender } from './computePdfRender'

/** Unscaled (scale-1) viewport dimensions of one page — scale-INDEPENDENT. */
export interface PageDims {
  w: number
  h: number
}

/**
 * The MINIMAL document surface this hook needs — deliberately structural rather than
 * `PDFDocumentProxy`.
 *
 * Why: the hook reads exactly `getPage(n)` and that page's scale-1 viewport size.
 * Depending on the full proxy forced every test to cast its mock `as never`, which is
 * a blunt instrument that would silently absorb a real mismatch if this hook later
 * started reading, say, `numPages`. A real `PDFDocumentProxy` satisfies this
 * structurally, so callers are unaffected. @issue utof/linsae#185
 */
export interface PageDimsSource {
  getPage(pageNumber: number): Promise<{
    getViewport(params: { scale: number }): { width: number; height: number }
  }>
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
  // Only `w` is guarded because only `w` is a DIVISOR (fitScale = containerWidth / w),
  // so w === 0 yields floor(0 * Infinity) = NaN and a NaN item size corrupts the
  // virtualizer. `h` is a multiplicand: h === 0 degrades to cssH 0, indistinguishable
  // from an unmeasured page. The asymmetry is deliberate, not an oversight.
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
export function usePdfPageDims(doc: PageDimsSource | null | undefined): {
  /** Read-only by contract: callers read it in `estimateSize`; only this hook writes. */
  dimsRef: RefObject<ReadonlyMap<number, PageDims>>
  fallback: PageDims | null
  /**
   * Why the page-1 probe failed, or `null` when it has not. Non-null means the
   * boot gate will NEVER open for this document (`fallback` stays null by
   * design), so the reader must render an error state instead of a pane that is
   * blank forever with only a console line to explain it. @issue utof/linsae#183
   */
  error: string | null
  ensureDims: (pageNumber: number) => Promise<PageDims | null>
} {
  const dimsRef = useRef<Map<number, PageDims>>(new Map())
  const [fallback, setFallback] = useState<PageDims | null>(null)
  const [error, setError] = useState<string | null>(null)
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
    setError(null)
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
      // Do NOT reopen the gate on failure — `fallback === null` is what keeps doc A's
      // heights from leaking into doc B (see the swap note above). But do not swallow
      // the reason either: pdf.js resolves getDocument() before validating the page
      // tree, so a corrupt page-1 object opens fine and fails only here, leaving a
      // permanently blank pane. The console line is for us; `error` is what the reader
      // renders so the user is not left staring at an empty pane. @issue utof/linsae#183
      .catch((err: unknown) => {
        console.error('[usePdfPageDims] page 1 dims failed', err)
        // Same generation guard as the success path: a rejection from doc A must not
        // paint an error over doc B, which may be loading perfectly well.
        if (genRef.current !== gen) return
        setError(err instanceof Error ? err.message : String(err))
      })
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
      // Capture the SET, not just the generation: the effect above installs a fresh
      // Set on every document swap, so a `finally` that re-read `inFlightRef.current`
      // would delete this page from the NEXT document's in-flight set — clearing a
      // marker it never placed and letting a duplicate getPage through for a page
      // that is still airborne. Deleting from our own (now-discarded) set is a no-op.
      const inFlight = inFlightRef.current
      inFlight.add(pageNumber)
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
        inFlight.delete(pageNumber)
      }
    },
    [doc],
  )

  return { dimsRef, fallback, error, ensureDims }
}
