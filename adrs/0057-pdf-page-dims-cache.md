# 0057 — The scale-free page-dims cache is `estimateSize`'s source of truth

Status: accepted (v0.8)

## Context

A virtualizer needs a height for every item — including the 497 pages nobody has looked at.
ADR 0056 put the reader on `@tanstack/react-virtual`, which leaves open where those heights
come from and how they get corrected.

The virtualizer's own `itemSizeCache` cannot be that source. It holds **pixel heights at the
current scale**, and `virtualizer.measure()` clears all of them
(`virtual-core/dist/esm/index.js:1093-1099`). Since a zoom step *requires* `measure()` (spec
§4.5), using it as the store would discard hundreds of resolved measurements on every wheel
notch of a 500-page book.

Meanwhile criterion 2 says a 500-page document must cost exactly **one `getPage` at open** —
so the heights have to be extrapolated from one page and corrected incrementally, and the
correction path has to actually reach the virtualizer, which it does not do for free.

## Decision

**`usePdfPageDims(doc)` owns a ref-backed `Map<pageNumber, {w, h}>` of UNSCALED (scale-1)
viewport dims, and that map is `estimateSize`'s only source of truth**
(`src/renderer/src/pdf/usePdfPageDims.ts`).

- Dims are **scale-free**, so they survive every zoom step, every dock resize and every
  `measure()`. After a `measure()` wipes `itemSizeCache`, `estimateSize` re-derives an exact
  height for every page ever seen.
- **Ref, not state**: N mounted pages write to it, and a state-backed map would re-render
  the pane (and re-bind the excerpt listener) on every scroll frame.
- On document load it resolves **page 1 only**, stored as both `dims[1]` and the `fallback`
  estimate for every unresolved page (`usePdfPageDims.ts:106-136`).
- `estimateHeight` **delegates to `computePdfRender`** (`usePdfPageDims.ts:46-60`) rather
  than hand-rolling `h * (cw/w) * zoom`. That is not stylistic: hand-rolling associates as
  `(h·fs)·zoom` whereas `computePdfRender` computes `scale = fs*zoom; floor(h*scale)`, and
  floating-point multiplication is non-associative — the two can differ by a whole pixel
  after flooring. The estimate is therefore **byte-identical to the rendered `cssH` by
  construction**, which is the premise everything below rests on.

### Invalidation has exactly two paths — and mutating the Map is neither

`getMeasurements` is memoized on `[getMeasurementOptions(), itemSizeCacheVersion]`
(`virtual-core/dist/esm/index.js:589-590`) and `getMeasurementOptions`'s deps are
`[count, paddingStart, scrollMargin, getItemKey, enabled, lanes, laneAssignmentMode]`
(`:558-567`).
`estimateSize` appears in neither. So writing a new entry into `dimsRef.current` changes
**nothing** until one of:

1. **`virtualizer.resizeItem(index, estimateHeight(...))`** — for a page whose real dims
   just resolved and differ from the page-1 extrapolation (the landscape-among-portrait
   case). The prefetch effect (`PdfReader.tsx`, the effect keyed on `windowKey`) does this
   under three rules: skip while `virtualizer.isScrolling` (a fling through 500 pages must
   not issue hundreds of worker round-trips), coalesce (`ensureDims` returns dims only when
   **newly** learned), and drop results for pages that left the window mid-flight.
2. **`virtualizer.measure()`** — for a scale change, which invalidates every pixel height at
   once by bumping `itemSizeCacheVersion`. This is why `measure()` in the zoom re-anchor
   effect (`PdfReader.tsx`, the `useLayoutEffect` on `[zoom, containerWidth]`) is
   unconditional and runs *before* the null-anchor bail: it is load-bearing for the whole
   list, not just for the anchor.

Regression gates assert the **resulting layout**, not that `resizeItem` was called — only
the layout proves the new dims reached the virtualizer (`PdfReader.test.tsx`, *"resizes a
page whose real dims differ from the estimate (landscape among portrait)"*).

### `useCachedMeasurements: true` — a deliberate deviation from spec §4.2

Spec §4.2 says `measureElement` "stays wired (cheap, corrects sub-pixel disagreement) but is
not load-bearing." **The sub-pixel clause is false for this component**, and acting on it
would break the list. Because `estimateHeight` delegates to `computePdfRender`, the estimate
equals the rendered `cssH` exactly, and the page wrapper carries no box model — so there is
nothing for a DOM measurement to correct. There *is* something for it to break: `PdfPage`'s
wrapper is height-auto between mount and first raster (its `css` state is null until dims
resolve, `PdfPage.tsx:84`, `:216`), so a live `measureElement` writes that **transient**
height into `itemSizeCache` and collapses the item.

virtual-core 3.17.3 ships `useCachedMeasurements` (`dist/esm/index.d.ts:89`, default `false`
at `index.js:278`). With it on, the default `measureElement` returns
`itemSizeCache.get(key) ?? estimateSize(index)` instead of reading the DOM
(`index.js:127-132`) — a provable no-op.
The ref is still passed so `elementsCache` / `indexFromElement` stay wired (the `measureRef`
prop handed to each `PdfPage`). `PdfReader.test.tsx`'s *"lays pages out at estimateSize +
gap, NOT at a DOM-measured height"* pins this: under the harness the transient height is
1000 and in a real browser it is the canvas's intrinsic 150, either of which collapses the
list, so the test asserts page 2's `translateY` is exactly `PORTRAIT_H + PAGE_GAP_PX`.

### `getItemKey` must be a module-scope constant, never an inline arrow

`getItemKey` is a dep of the `getMeasurementOptions` memo (`index.js:563`), and `memo`
compares deps by **identity** (`utils.js:11`, `deps[index] !== dep`). An inline arrow is a
fresh identity on every render, which invalidates `getMeasurements` and **rebuilds all N
measurements on every render** — O(500) per scroll frame on a 500-page book. It also
*masked* the stale-cache hazard below, making the guard that defends against it untestable.
Hence the hoisted `pageNumberKey` (`PdfReader.tsx`, consumed as the `getItemKey` option)
with the rationale written at the definition site.

### The `getTotalSize()`-before-read rule

**`measure()` leaves `measurementsCache` stale.** It clears `itemSizeCache`, clears lane
assignments, bumps `itemSizeCacheVersion` and notifies (`index.js:1093-1099`) — it does
**not** reassign `measurementsCache`, which is rebuilt only inside the memoized
`getMeasurements` (assignment at `:659` on the `lanes === 1` path). Reading the cache
straight after `measure()` therefore returns **pre-change** `start`/`size`, and an offset
computed from it is in the old scale — the "a zoom step at page 300 throws the reader
hundreds of pages away" failure spec §4.5 exists to prevent.

`getTotalSize()` calls `getMeasurements()` (`index.js:1037-1039`), which reassigns the
cache. So the rule is: **force the recompute, then read.** It is enforced in one place —
`readAnchorItem` (`PdfReader.tsx`) — and **all four jumps** go through it: zoom re-anchor,
boot restore, read-back drain, jump-to-page. Those four are three call sites, because boot
restore and read-back drain share one: the perform effect resolves `jump ?? restore` to a
single target and runs whichever won. Do not inline `measurementsCache[...]` at any of them.

Two corollaries recorded because they are easy to get wrong:

- **`measurementsCache` at `lanes === 1` is a lazy `Proxy` over a sparse array**
  (`dist/esm/lazy-measurements.js`) that materializes `{index, key, start, size, end, lane}`
  on **numeric index access**. Numeric indexing is safe; `.slice()`, spread, `map`, and
  plain-array assumptions are not.
- **`ready` is stale on the commit where `doc` changes.**
  `ready = containerWidth > 0 && fallback != null` is computed at render time
  (`PdfReader.tsx`), while `usePdfPageDims` re-nulls `fallback` from an *effect* on `[doc]` —
  one render too late for a drain effect in the same commit to observe. So the first restore
  attempt after a swap runs against a virtualizer that is about to be disabled,
  `readAnchorItem` returns null, and the target must survive for the attempt that follows
  once the gate genuinely reopens. **Restore
  targets are therefore cleared on SUCCESS, not on effect entry** (the restore/jump-drain
  effect in `PdfReader.tsx` clears `jumpTargetRef` / `restoreTargetRef` only after
  `readAnchorItem` returns an item); clearing on entry silently drops every swap-time
  restore.

### The boot gate — and its second job

`ready = containerWidth > 0 && fallback != null` (`PdfReader.tsx`), passed as
`enabled: ready`. Both halves are load-bearing:

- **`containerWidth > 0`**: it is `0` until the `ResizeObserver` fires, and
  `fitScale = containerWidth / w` makes every `estimateSize` return `0` → `getTotalSize()`
  of `0`, with nothing to recompute it afterwards.
- **`fallback != null`**: this is what re-closes the gate across a **document swap**, and
  `enabled: false` is the only thing that clears virtual-core's `itemSizeCache`
  (`index.js:601-605`). Without it, doc A's pixel heights leak into doc B. `usePdfPageDims`
  therefore does **not** reopen the gate when the page-1 probe fails — it surfaces `error`
  instead, which the reader renders ([#183](https://github.com/utof/linsae/issues/183)),
  because pdf.js resolves `getDocument()` before validating the page tree, so a corrupt page
  1 opens "successfully" and fails only here.

`estimateHeight` guards **only `w`**, deliberately: `w` is the divisor in `fitScale`, so
`w === 0` yields `floor(0 * Infinity)` = `NaN` and a NaN item size corrupts the virtualizer.
`h` is a multiplicand and degrades to height 0, indistinguishable from an unmeasured page.
The asymmetry is documented at both guard sites (`usePdfPageDims.ts:54-58`,
`PdfPage.tsx:99-108`).

## Alternatives

- **Let the virtualizer's `itemSizeCache` be the store, with `measureElement` doing real DOM
  measurement.** Rejected on the two facts above: `measure()` wipes it on every zoom step,
  and DOM measurement of a height-auto wrapper writes a transient value that collapses the
  item. It is not merely redundant — it is actively wrong here.
- **Resolve all page dims eagerly at open.** Rejected: 500 `getPage` worker round-trips at
  open is exactly the stall criterion 2 forbids. One page + extrapolation + windowed
  correction is what makes a book open instantly.
- **Store `PageDims` in React state instead of a ref.** Rejected: N children write it during
  scroll, so every write would re-render the pane and re-bind the excerpt `mouseup`
  listener.
- **Skip `resizeItem` and rely on `measure()` alone after each dims resolution.** Rejected:
  `measure()` clears *every* item's pixel height to force a full re-derive — correct but
  O(N) per page learned, where `resizeItem` is the targeted single-item path virtual-core
  provides.

## Consequences

- **Any new jump must call `readAnchorItem`, not `measurementsCache[...]`.** This is the
  single highest-value line in this ADR: the stale-cache bug is silent, reproduces only
  after a scale change, and lands the reader hundreds of pages away.
- **`getItemKey` staying a module-scope constant is load-bearing**, not tidiness. Inlining
  it is a one-character-looking change with an O(N)-per-frame cost.
- **`measurementsCache` must only ever be indexed numerically** while `lanes === 1`. If the
  reader ever adopts multiple lanes, `measurementsCache` is assigned a plain array on that
  path (`index.js:662`, `:704`) and the Proxy caveat stops applying — but so does the
  `_flatMeasurements` fast path everything else here assumes, so re-verify rather than
  assume.
- **Restore/jump targets are cleared on success only.** Any future restorable target added
  to the reader inherits the stale-`ready` hazard and must follow the same discipline.
- **Known limitation — a single large zoom delta re-anchors to the wrong page**
  ([#188](https://github.com/utof/linsae/issues/188)): the spacer's height is rendered from
  `getTotalSize()` one commit behind the `scrollToOffset`, so a large jump is clamped by the
  browser before the taller spacer commits. `readAnchorItem` is correct; the DOM has not
  caught up yet.
- **Deviating from spec §4.2's `measureElement` clause is recorded here as the amendment.**
  The spec text stands as written; this ADR is the correction of record.

## Sources

- `src/renderer/src/pdf/usePdfPageDims.ts` — the ref-backed scale-free map (`:96-136`),
  `estimateHeight` delegating to `computePdfRender` (`:46-60`), the `w`-only guard
  (`:54-58`), `ensureDims`'s coalescing + generation guard (`:145-171`), and the "do not
  reopen the gate on failure" note (`:123-135`).
- `src/renderer/src/pdf/PdfReader.tsx`, by symbol (this file is edited every PDF batch, so
  line numbers go stale faster than the claims): `readAnchorItem` + its TSDoc (the
  `getTotalSize()`-before-read rule), `pageNumberKey`, the `ready` boot gate, the
  `useCachedMeasurements` rationale inside the `useVirtualizer` options, the `windowKey`
  prefetch effect, the `[zoom, containerWidth]` layout effect's unconditional `measure()`,
  `jumpToPage`, and the restore/jump-drain effect's clear-on-success.
- `@tanstack/virtual-core@3.17.3/dist/esm/index.js:1093-1099` (`measure()` — no
  `measurementsCache` reassignment), `:589-590` (`getMeasurements` memo deps), `:558-567`
  (`getMeasurementOptions` deps, `getItemKey` at `:563`), `:659` (cache assignment on the
  `lanes === 1` path), `:1037-1039` (`getTotalSize()` → `getMeasurements()`), `:601-605`
  (`enabled: false` clears `itemSizeCache`), `:127-132` (`useCachedMeasurements`
  `measureElement`),
  `:278` (default `false`); `dist/esm/index.d.ts:89`; `dist/esm/utils.js:11` (`memo`
  identity comparison); `dist/esm/lazy-measurements.js` (the Proxy).
- `src/renderer/src/pdf/PdfReader.test.tsx`, by test name — *"lays pages out at estimateSize
  + gap, NOT at a DOM-measured height"*, *"resizes a page whose real dims differ from the
  estimate (landscape among portrait)"*, *"renders NOTHING until containerWidth > 0 (boot
  gate)"*, *"opens a 500-page document with ONE getPage before the first page is windowed"*,
  *"renders an error state instead of a blank pane when page 1 fails (#183)"*.
- `docs/specs/v0.8-multipage-pdf.md` §4.2, §4.2.1, §4.5.
- `adrs/0056-pdf-continuous-scroll-virtualization.md` — the virtualizer these heights feed.
