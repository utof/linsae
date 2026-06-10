# 0021 — Per-row `--wy` offset wave reveal (repulsion-wave entrance)

Status: accepted (v0.2.2)

## Context

The v0.2.2 milestone adds a second feed-entrance animation to complement the
existing scroll-glide (ADR 0020): a "same-polarity magnet" wave where the
newcomer rises from below the fold and shoves the notes above it upward in a
propagating spring wave.

Three design constraints shaped the approach:

1. **Virtual rows can't be FLIP-animated.** The feed rows are already
   `transform: translateY(…)` by the virtualizer's position engine. Motion's
   `layout`/`layoutId` FLIP projection re-measures the DOM and applies a
   counter-transform each frame — it fights the virtualizer's own transforms and
   silently no-ops on async-inserted rows (TanStack Virtual #693, also cited in
   ADR 0019). A second, independent `translateY` or `top` animation would
   compound with the virtual position.
2. **`directDomUpdates` must stay OFF.** react-virtual's `directDomUpdates`
   path writes `transform`/`top` directly to each row node outside React,
   bypassing `onChange`→re-render entirely for position-only changes. Enabling
   it would overwrite the wave's `--wy` offset on every virtualizer tick, and
   virtual-core's standard `measureElement` path (which the wave relies on for
   the newcomer's `offsetHeight`) only fires on the normal React-driven render
   path.
3. **The virtualizer's own follow/anchor machinery must not fight the wave.**
   virtual-core@3.16.1's `setOptions` gates the **entire** append-follow +
   scroll-anchor block on `merged.anchorTo === "end"` (index.js:274). When that
   block runs it sets `pendingScrollAnchor`; `_willUpdate` (fired in
   react-virtual@3.14.1's own `useIsomorphicLayoutEffect` at index.js:103)
   consumes `pendingScrollAnchor` and calls `this.scrollToEnd(…)` (virtual-core
   index.js:476-477), which arms `reconcileScroll`'s self-correcting rAF loop
   (index.js:1105). The wave drives `sc.scrollTop` and `--wy` directly; if
   `reconcileScroll` is simultaneously trying to re-pin the newcomer to the
   bottom, the `--wy` rise is cancelled.

   **The timing hazard is critical.** react-virtual@3.14.1 rebuilds
   `resolvedOptions = { ...options }` fresh each render (index.js:53-81) and
   calls `instance.setOptions(resolvedOptions)` in the render body (index.js:98)
   — BEFORE any layout effect. `instance._willUpdate()` runs in react-virtual's
   OWN `useIsomorphicLayoutEffect` (index.js:102-104) — which fires BEFORE any
   later layout effect registered in the Feed. So a post-hook mutation such as
   `virtualizer.options.anchorTo = 'start'` (which the glide used as a
   workaround) is too late: setOptions already ran with `anchorTo:'end'`, the
   follow block already queued its `pendingScrollAnchor`, and `_willUpdate`
   already fired `scrollToEnd` before the Feed's append layout effect runs. The
   glide survived that form only because it drives `scrollTop` itself and
   cooperates with the follow; the wave does not.

## Decision

**`--wy` CSS-variable transform layer driven by an id-keyed Motion frame loop.**

Each virtual row's `transform` is `translateY(calc(<virtual-start>px + var(--wy, 0px)))`.
The wave engine (`useWaveReveal`) owns a `Map<noteId, {off, vel, delay}>` ref that
lives **outside** the rows; on a single append it seeds every rendered row with
`off = +shift` (shift = newcomer `offsetHeight`, transform-immune) and a per-row
delay of `(newIndex − idx) × 20ms`. One `Motion frame.update(tick, true)` loop
integrates offsets toward 0 with a semi-implicit Euler spring step (ω²=180,
damping=18). Recycle-safety is via `notesRef.current[data-index].id` — a recycled
DOM node paints the offset for whatever note now occupies that index.

**The append-guard finding (load-bearing):** `suppressFollow` —
`sendInFlight || revealing || waveSettling` — is computed ABOVE `useVirtualizer`
in the Feed render body and passed directly into the hook as
`anchorTo: suppressFollow ? 'start' : 'end'` and
`followOnAppend: !suppressFollow`
(`src/renderer/src/feed/Feed.tsx:273-274`).
`sendInFlight` is set on submit and holds TRUE through the append render. The wave
runner additionally calls `setWaveSettling(true)` at append and `false` on spring
retire, extending the suppression window through the full spring window —
`suppressFollow` stays TRUE for every render from submit through retire, ensuring
every `setOptions` call that render sees `anchorTo:'start'`, `followOnAppend:false`,
and `_willUpdate` never fires `scrollToEnd` for the duration of the wave.

**Two sub-models share the engine:**

- **`flip`** — pure spring settle; rows overlap softly during the wave (the stagger
  reduces this; flip is intentionally exempt from the no-overlap invariant — the
  v0.2.2 acceptance run measured a transient overlap on the order of ~100px for a
  tall note, which the spring resolves as the stack settles).
- **`pbd`** (position-based dynamics) — after the spring step, an up-only,
  bottom→top Gauss-Seidel projection (`projectNoOverlap`, 8 passes) enforces
  `gap[i,i+1] ≥ 0` for every adjacent pair. The newcomer (last row, index N-1) is
  the pinned anchor — it is only ever the lower of a pair, so it is never pushed.
  Rows outside the seed set get lazily created at rest when the projection pushes
  them off 0, letting the shove propagate further than the seeded window. PBD gives
  the hard no-overlap guarantee without a constraint solver; `flip` is cheaper and
  acceptable when soft overlap is fine.

## Alternatives

- **Motion `layout` FLIP:** disqualified — fights virtualizer transforms + async-
  inserted row failure (TanStack Virtual #693; ADR 0019).
- **`resizeItem` height-unroll (per-frame resize):** `resizeItem` has an
  unconditional `wasAtEnd` branch (virtual-core@3.16.1 index.js:825/854, also
  gated on `anchorTo:'end'`) that accumulates an internal scroll adjustment only
  cleared by a REAL scroll event; driving `scrollTop` directly never fires that
  clear, so overlapping sends desync the virtualizer's range window (the #66
  "white wall" bug — `glideReveal.ts` documents this and avoids it for the same
  reason). The `--wy` layer never calls `resizeItem`.
- **Absolute-positioned overlay canvas:** simpler in some ways, but decoupled from
  the real DOM layout — pixel offsets desync the moment the virtualizer recomputes
  its range (scroll, resize, measure).
- **`directDomUpdates`:** ruled out (see Context constraint 2 above).
- **Post-hook `virtualizer.options.anchorTo` mutation:** ruled out (see Context
  constraint 3 above — timing hazard).

## Consequences

- The wave layer is CSS-only (`--wy` custom property), so it composes cleanly with
  the virtualizer's existing `translateY` positioning — no extra DOM wrappers, no
  z-index conflicts.
- `suppressFollow` computed above `useVirtualizer` is now the **only** source of
  `anchorTo`/`followOnAppend` truth; no post-hook mutation of `virtualizer.options`
  is allowed anywhere in the Feed. This constraint is documented in
  `Feed.tsx:252-262`.
- `directDomUpdates` must remain `false` (the default) on the feed virtualizer.
  Enabling it would silently break the wave (style writes overwrite `--wy` on
  every virtualizer tick) and the glide (measure path bypassed).
- The `pbd` model adds 8 Gauss-Seidel passes per frame (~2-4μs for a typical
  rendered window of 10-20 rows); profiler-acceptable. The flip model is cheaper
  and is recommended for future fine-tuning if the spring feel is adjusted.
- Acceptance: `FEED=real` wave-reveal — all three strategies (glide control, flip,
  pbd, pbd SLOW=1 with 80 seeds) RISE with correct `snapRatio`; reveal-stress 8
  #66/#67 invariants all PASS (T12, commit `5ba17cc` spike + T12 run on this
  branch).

## Sources

- `src/renderer/src/feed/entrance/waveReveal.ts` — wave engine
- `src/renderer/src/feed/entrance/pbdProjection.ts` — PBD up-only projection
- `src/renderer/src/feed/entrance/waveSpring.ts` — semi-implicit Euler spring step
- `src/renderer/src/feed/Feed.tsx:232-274` — suppressFollow computation and
  `useVirtualizer` options
- `scripts/wave-reveal.mjs` — single-send rise acceptance harness (snapRatio metric)
- `scripts/reveal-stress.mjs` — burst-send #66/#67 invariant harness
- react-virtual@3.14.1 `dist/esm/index.js`:
  - Line 53-81: `resolvedOptions = { ...options }` rebuilt fresh each render
  - Line 98: `instance.setOptions(resolvedOptions)` in render body
  - Line 102-104: `instance._willUpdate()` in react-virtual's own
    `useIsomorphicLayoutEffect` (BEFORE Feed layout effects)
  - https://github.com/TanStack/virtual/tree/main/packages/react-virtual
- virtual-core@3.16.1 `dist/esm/index.js`:
  - Line 274: `if (… merged.anchorTo === "end" …)` guards entire follow block
  - Line 476-477: `followOnAppend` → `this.scrollToEnd(…)`
  - Line 825/854: unconditional `wasAtEnd` resizeItem branch
  - Line 1105: `reconcileScroll()` definition
  - https://github.com/TanStack/virtual/tree/main/packages/virtual-core
- TanStack Virtual #693 — FLIP/layout animation fails on async-inserted virtual
  rows: https://github.com/TanStack/virtual/discussions/693
- ADR 0019 (`adrs/0019-motion-animation-library.md`) — Motion adoption + no
  `layout`/`layoutId` inside the feed guardrail
- ADR 0020 (`adrs/0020-remove-send-ghost.md`) — why the send ghost was removed;
  scroll-glide as the base send animation
