# 0056 — Continuous-scroll PDF on `@tanstack/react-virtual`, not pdf.js `PDFViewer`

Status: accepted (v0.8)

## Context

The v0.6 slim slice rendered **page 1 only** (ADR 0043) — one `<canvas>`, one `TextLayer`,
one viewport, one origin element. #154 asks for the rest of the document, and the target is
a 500-page book that opens without stalling and scrolls without allocating per-page state
for pages nobody has looked at.

Two engines were genuinely available:

1. **pdf.js's own viewer.** `pdfjs-dist` ships `pdfjs-dist/web/pdf_viewer.mjs`, a complete
   continuous-scroll web viewer.
2. **Hand-roll the page list on `@tanstack/react-virtual`** — already a direct dependency
   (`3.14.5`, symlinked to `virtual-core@3.17.3`), already the subject of ADR 0005 and of
   the whole feed-scroll saga, and bumped as recently as v0.7 (ADR 0054).

There is also a lifecycle question that only appears once N pages exist: 3–5 pages are
resident at any moment and each one owns a `RenderTask`, a `TextLayer`, a canvas backing
store, a `PDFPageProxy` and a registry entry. On a 500-page scroll that teardown runs
hundreds of times, so its **order** is worth deciding once and writing down rather than
rediscovering.

## Decision

**Hand-roll the list on `@tanstack/react-virtual`** (`src/renderer/src/pdf/PdfReader.tsx`),
one `PdfPage` per virtual item (`src/renderer/src/pdf/PdfPage.tsx`).

`PDFViewer` was rejected because it owns exactly what this app must own: its own scroll
container and scroll modes, its own event bus, its own `pdf_viewer.css` visual language, and
its own page lifecycle. Excerpt-drag, fit-to-width derived from the live dock width (ADR
0047), v21 tokens and session persistence (ADR 0053) would each be a fight against it. It is
also a *web-app artifact*, not part of the stable documented core API that ADR 0043
committed us to — so leaning on it would widen the pdf.js surface we depend on well past
what that ADR scoped.

### Virtualizer configuration that is load-bearing, not taste

- **`getItemKey` keys by PAGE NUMBER, not index** (`pageNumberKey`, `PdfReader.tsx`), and
  the React `key` is `item.key`. This pins instance identity: `PdfPage`'s unmount effect
  captures `pageNumber` **at mount** and deregisters with it (`PdfPage.tsx:190-205`), which
  is only correct if an instance can never be recycled for a different page. It must
  additionally stay a **module-scope constant** for a reason that belongs to the measurement
  machinery — see ADR 0057.
- **Inter-page separation is the virtualizer's `gap` option** (`PAGE_GAP_PX = 12`,
  `PdfReader.tsx`), never box model on the item. `gap` folds into an item's `start`, not its
  `size` (`virtual-core/dist/esm/index.js:648`), so `estimateSize` stays byte-equal to the
  rendered `cssH`. A border/padding/shadow on the page wrapper would make every estimate
  under-report.
- **`overscan` is zoom-dependent**: `zoom > 1 ? 0 : 1`, in the `useVirtualizer` options
  block. Backing-store area scales with zoom², so a resident page at `ZOOM_MAX` costs ~25× a
  page at fit — a page of lookahead is cheap at fit and not cheap zoomed in.

### Why there is NO `shouldAdjustScrollPositionOnItemSizeChange` override

`Feed` assigns a custom, always-true-when-idle predicate (`feed/Feed.tsx`, ADR 0054); the
reader deliberately does not, and that asymmetry is the kind of thing a later reader
"harmonizes" by mistake. virtual-core consults the default branch only when the instance
property is left `undefined` — the ternary at `virtual-core/dist/esm/index.js:849`, whose
`else` is the default at `:862-869`:

```
itemStart < this.getScrollOffset() + this.scrollAdjustments
  && (!this.itemSizeCache.has(key) || this.scrollDirection !== "backward")
```

That default is **strictly better** here on all three clauses:

- `itemStart < getScrollOffset() + scrollAdjustments` compensates **only above-viewport**
  resizes, which is exactly right: a page above the viewport growing from estimate to real
  height must not shift the page under the user's eyes, while a page *below* the viewport
  growing must not scroll anything at all. An always-true predicate would compensate the
  below case too, which is simply wrong for a reader.
- `!this.itemSizeCache.has(key)` means a **first measurement always compensates, in either
  scroll direction** — this is TanStack/virtual#1199's clause, landed in the 3.17.3 bump
  (ADR 0054). The reader's dominant case *is* first measurement: `resizeItem` fires once per
  page as its real dims resolve (ADR 0057). Feed's custom predicate exists precisely to
  force this behavior on the older release; the reader gets it from the default and needs no
  override. (#172 tracks relaxing Feed's.)
- `scrollDirection !== "backward"` then skips *re-*measurement cascades while scrolling up.
  The reader barely re-measures — dims are learned once per page and are scale-free — so the
  clause costs nothing and guards the pathological case for free.

### Teardown order — a PROMPTNESS decision, not leak-prevention

Unmount runs, in this order (`PdfPage.tsx:190-205`, plus the render effect's cleanup at
`:173-176` which React destroys first, in hook-declaration order):

1. `renderTask.cancel()`
2. `textLayer.cancel()`
3. `page.cleanup()`
4. `canvas.width = canvas.height = 0`
5. deregister from the page registry

The honest framing, verified in pdf.js source: `PDFPageProxy.cleanup()` sets
`#pendingCleanup = true` and **does not clear it on failure**
(`pdfjs-dist/build/pdf.mjs:15693-15700`); `#tryCleanup()` returns `false` while any intent
state has `renderTasks.size > 0 || !operatorList.lastChunk` (`:15701-15717`, guard at
`:15709-15711`); and the render task's completion handler calls `#tryCleanup()` **again**
(`:15535`). So calling `cleanup()` *before* cancelling is not a permanent leak — it is a
**deferred** cleanup that lands when the in-flight render finishes. The order buys
promptness, and at book scale promptness is the whole point. Anyone reversing this should
know they are trading release latency, not correctness.

Two details inside that order are load-bearing and non-obvious:

- **The canvas element is captured at MOUNT, not read from the ref at teardown.** React
  detaches host refs during `commitDeletionEffects`, which runs *before* passive-effect
  destroy functions, so `canvasRef.current` is already null in the cleanup and the backing
  store would silently never be released (`PdfPage.tsx:192-195`).
- **`textLayer.cancel()` rejects the awaited `render()` with `AbortException`, not
  `RenderingCancelledException`.** `TextLayer.cancel()` constructs
  `new AbortException("TextLayer task cancelled.")` and rejects its capability with it
  (`pdfjs-dist/build/pdf.mjs:14795-14800`), and `render()` returns that capability's promise
  (`:14743-14765`). A catch that swallows only `RenderingCancelledException` therefore logs
  a real-looking error on **every** cancel — i.e. on every scale change and every page that
  scrolls out mid-render. The catch swallows both by name (`PdfPage.tsx:160-169`).

### A scale change is NOT an unmount

The lifecycle is split across two effects on purpose. A `containerWidth`/`zoom` change
cancels the in-flight render and re-rasterizes into the **same** canvas; it must not run
steps 3–5. Assigning any value to `canvas.width` — *even the value it already holds* —
clears the bitmap per the HTML spec, so the unmount path's zero-then-resize would flash
white across every resident page on the reader's most-used interaction. Hence the
conditional writes at `PdfPage.tsx:125-126` and the empty dep array on the unmount effect
(`:205`), which is why that `biome-ignore` is documented rather than silenced.

## Alternatives

- **pdf.js `PDFViewer` (`pdfjs-dist/web/pdf_viewer.mjs`).** Rejected above. The trigger to
  revisit is concrete: if annotation (Stage 2 in `docs/canvas-vision.md` §PDFs) turns out to
  need pdf.js's annotation-layer *and* editor plumbing, the cost of re-implementing those
  against the core API may exceed the cost of surrendering the scroll container. That is a
  whole-milestone decision, not a refactor.
- **Render all N pages, no virtualization.** Rejected on the stated target: 500 canvases
  plus 500 text layers is unbounded memory and an unbounded open cost, and criterion 2 ("one
  `getPage` at open") is unachievable by construction.
- **Keep `PdfPage` mounted and only swap its bitmap** (a fixed pool of page slots recycled
  by index). Rejected: it defeats `getItemKey`'s instance-identity guarantee, and the
  registry + unmount deregistration would have to become an explicit lifecycle protocol
  instead of a React effect.
- **Copy Feed's always-true `shouldAdjustScrollPositionOnItemSizeChange`** for consistency.
  Rejected with reasons above — consistency would be a regression here.

## Consequences

- **The reader now depends on virtual-core's DEFAULT scroll-adjust predicate**, unlike Feed.
  A future virtual-core bump that changes that default (`index.js:862-869`) affects the
  reader and not the feed, and vice versa. Both surfaces have real-Electron smokes;
  `pnpm smoke:pdf-multipage` is the reader's (`scripts/pdf-multipage-smoke.mjs`).
- **happy-dom cannot see any of this.** The Vitest suite runs against `installPdfLayout`
  (`tests/pdf-layout.ts`) with a stubbed `ResizeObserver`, so canvas rasterization, text
  layers, real scroll geometry and memory are only covered by the `_electron` smoke's twelve
  gates (`scripts/pdf-multipage-smoke.mjs`) — including `continuous-scroll`,
  `last-page-raster`, `500-page-open-no-stall` and `zoom-max-renderer-memory`.
- **Known limitation — a zoom step mid-text-layer-render leaves the stale layer appending
  spans** ([#186](https://github.com/utof/linsae/issues/186)). The render effect's
  `cancelled` flag stops the *await* chain, but a `TextLayer` already pumping is only
  stopped by `cancel()`, which today runs on unmount, not on a scale change.
- **Known limitation — the GPU process grows ~200 MB at max zoom**
  ([#187](https://github.com/utof/linsae/issues/187)). `capBitmapPixels` bounds the canvas
  backing store, not the composited layer the compositor keeps for it. This is the strongest
  argument for the deferred tiled renderer (spec §4.4); the pixel cap is a bound, not a fix.
- **Known limitation — a single large zoom delta re-anchors to the wrong page**
  ([#188](https://github.com/utof/linsae/issues/188)): the spacer height lags one commit
  behind the re-scroll, so a big jump lands clamped. Ordinary wheel-notch zoom is
  unaffected.

## Sources

- `src/renderer/src/pdf/PdfReader.tsx` — `pageNumberKey` and its TSDoc, the `PAGE_GAP_PX`
  constant, and the `useVirtualizer` options block (`getItemKey` / `gap` / `overscan` /
  `useCachedMeasurements` / `enabled`). Cited by symbol: this file is edited every PDF
  batch, so line numbers here go stale faster than the claims do.
- `src/renderer/src/pdf/PdfPage.tsx:160-169` (the two-exception catch), `:173-176`
  (render-effect cancel), `:190-205` (unmount-only teardown; mount-captured canvas at
  `:192-195`), `:125-126` (conditional `canvas.width` writes).
- `@tanstack/virtual-core@3.17.3/dist/esm/index.js:826` (`resizeItem`), `:849`
  (custom-vs-default predicate ternary), `:862-869` (the default predicate), `:648` (`gap`
  folded into `start`); `dist/esm/index.d.ts:117`
  (`shouldAdjustScrollPositionOnItemSizeChange` is an instance property, not an option).
- `pdfjs-dist@6.0.227/build/pdf.mjs:14795-14800` — `TextLayer.cancel()` rejects with
  `AbortException`; `:14743-14765` — `render()` returns `#capability.promise`.
- `pdfjs-dist@6.0.227/build/pdf.mjs:15693-15700` (`cleanup()` sets `#pendingCleanup`),
  `:15701-15717` (`#tryCleanup()`, guard at `:15709-15711`), `:15535` (the render-completion
  handler calling `#tryCleanup()` again — the reason an out-of-order call is deferred, not
  lost).
- `docs/specs/v0.8-multipage-pdf.md` §4.1 (engine choice + verified API surface), §4.3
  (lifecycle), §4.4 (memory budget).
- `adrs/0043-pdf-engine-pdfjs-dist.md` — the core-API-only commitment this decision honors.
- `adrs/0005-tanstack-virtual.md`, `adrs/0054-virtual-core-3.17-bump.md` — the virtualizer
  and the 3.17.3 bump whose default predicate this reader relies on;
  [#172](https://github.com/utof/linsae/issues/172) tracks relaxing Feed's override.
- `adrs/0057-pdf-page-dims-cache.md` — where the heights come from, and why `getItemKey`
  must be a module-scope constant.
