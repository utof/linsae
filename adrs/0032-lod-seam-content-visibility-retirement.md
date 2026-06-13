# 0032 — LOD seam + `content-visibility` retired on transformed canvas surfaces

Status: accepted (v0.4)

## Context

The canvas long-arc is one surface that zooms semantically — readable markdown cards, through
title pills, down to a whole-vault dot field (`docs/canvas-vision.md` §Product thesis,
principle 5). v0.4 builds only the card tier, but it must do two things for that arc: (1) put the
tier model somewhere single and load-bearing so the title/dot milestone is a fill-in, not a
re-derivation; and (2) settle the off-screen-culling technique, because the obvious browser
primitive for "don't render off-screen content" — CSS `content-visibility` — was measured under
the canvas's animated scale transform and behaved badly.

The spike measured `content-visibility` directly under an animated scale transform and found it
**actively harmful**: `cv-all` ran at **11–12 fps** with 42–44 frames >100 ms — far worse than
just painting the cards — because style/layout relevance is re-evaluated for every boundary on
every zoom frame; and `cull+cv` was *strictly worse* than plain cull (cvSkipped = 0: pure
per-boundary overhead, no skipping) (`docs/research/2026-06-12-canvas-spike-results.md`
§Numbers, §Verdict).

## Decision

`src/renderer/src/canvas/lod.ts` is the **single source of tier truth**
(`docs/specs/v0.4-canvas-mvp.md` §12):

- `type LodTier = 'card' | 'title' | 'dot'`
- `TIER_THRESHOLDS = { title: 0.5, dot: 0.15 }` (zoom < 0.5 → title, < 0.15 → dot)
- `tierForZoom(zoom): LodTier`

v0.4 builds renderers for **`card` only**; the thresholds are load-bearing constants the
semantic-zoom milestone consumes, alongside the semantic-consistency invariant (anything visible
at a tier persists at all deeper tiers) recorded there (`src/renderer/src/canvas/lod.ts:1`,
`docs/canvas-vision.md` §Semantic zoom). The user zoom clamp `[0.5, 2.0]` sits its floor exactly
on the title-tier threshold, so normal use can never leave card tier
(`docs/specs/v0.4-canvas-mvp.md` §3, §12).

`content-visibility` is **BANNED on canvas surfaces** (`docs/specs/v0.4-canvas-mvp.md`
product-decision 6, §3). Off-screen culling is done with an rbush R-tree over placed-card world
rects — only viewport-intersecting cards mount (`docs/specs/v0.4-canvas-mvp.md` §3).

## Alternatives

- **`content-visibility: auto` for off-screen culling** — rejected. The spike measured it
  actively harmful under animated transforms: `cv-all` at 11–15 fps with frames >100 ms, and
  `cull+cv` strictly worse than plain cull (pure per-boundary overhead, zero skips). The verdict
  is explicit: "Retire content-visibility from the canvas plan"
  (`docs/research/2026-06-12-canvas-spike-results.md` §Verdict). The ban is scoped to
  *transformed* canvas contexts — the spike notes it is *expected* to remain fine for
  non-transformed scroll contexts like the feed (unmeasured there; do not cite the spike as
  evidence for the feed).

## Consequences

- The semantic-zoom milestone reads tier from one module — no scattered zoom-threshold magic
  numbers (`docs/specs/v0.4-canvas-mvp.md` §16, Future-contracts row "lod.ts tier enum +
  thresholds").
- Culling is rbush-only; `content-visibility` must not reappear on a transformed canvas surface.
  A future card-tier perf regression must reach for a different lever (the mount-churn
  amortization of ADR 0033), not re-introduce cv.
- The dev-tools HUD's LOD section (force-tier, unclamp-zoom, synthetic 10k dots) is what exercises
  the `dot` tier end-to-end on real data before the user-facing tier ships
  (`docs/specs/v0.4-canvas-mvp.md` §12).

## Sources

- `docs/canvas-vision.md` principle 5, §Semantic zoom
- `docs/specs/v0.4-canvas-mvp.md` §3 (culling, clamp), §12 (LOD seam), product-decision 6
  (content-visibility ban)
- `docs/research/2026-06-12-canvas-spike-results.md` §Numbers (cv-all 11.7 fps / 44 frames
  >100 ms; cull+cv strictly worse, cvSkipped=0), §Verdict ("Retire content-visibility")
- `src/renderer/src/canvas/lod.ts` — the implemented single source of tier truth
