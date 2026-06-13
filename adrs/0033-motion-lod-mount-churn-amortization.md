# 0033 — Motion-LOD as the mount-churn amortization choice

Status: accepted (v0.4)

## Context

rbush culling is the chosen mitigation for the card tier (ADR 0032), but the spike graded culling
**NEAR-PASS, not pass**: mean **51–56 fps** with **zero** frames >100 ms, but **p95 = 33.3 ms**
(`docs/research/2026-06-12-canvas-spike-results.md` §Numbers, §Verdict). The dips are clean
single missed vsyncs, concentrated where cards *enter* the viewport (KaTeX build + DOM append) —
i.e. **mount churn**. The vision makes this an explicit standing debt: "every card-tier milestone
owes a mount-churn amortization decision (idle prebuild / KaTeX render cache / motion-LOD
placeholder — the v0.4 spec makes the first call)" (`docs/canvas-vision.md` principle 5).

This ADR records v0.4's call.

## Decision

v0.4 amortizes mount churn via **motion-LOD** (`docs/specs/v0.4-canvas-mvp.md` §3, amended
2026-06-13):

- While the camera is in motion (pan/zoom velocity above a small threshold), a newly-entering
  card mounts as a **cheap placeholder** — title line + body-shaped skeleton, **no
  markdown/KaTeX work**.
- On camera **settle** (~120 ms idle), placeholders **upgrade** to full cards.
- A **mounted keep-alive LRU** of recently-exited cards (`display: none`, **never**
  `content-visibility` — ADR 0032) lets re-entering cards skip a remount.

The title line uses the shared `noteTitle(note)` helper, the single source for every title-shaped
surface (`docs/specs/v0.4-canvas-mvp.md` §3).

## Alternatives

- **Full parse-level caching / idle-time prebuild** — deferred unless the §3 gates fail
  (`docs/specs/v0.4-canvas-mvp.md` §3). Not built in v0.4.
- **Element-level `(note id, updated_at)` caching** (the original 2026-06-13-superseded plan) —
  rejected: react-markdown **re-parses on every mount**, so a memoized element keyed by
  `(note id, updated_at)` cannot survive an unmount; the cache would miss exactly on the
  re-entry it was meant to cover (`docs/specs/v0.4-canvas-mvp.md` §3). The mounted keep-alive LRU
  is the answer to re-entry instead — it keeps the element *mounted*, so no re-parse happens.

## Consequences

- **Verified on real hardware (Quadro RTX 3000, 60 Hz, vsync 16.7 ms): the card tier PASSES the
  §3 gates with motion-LOD** — churn 59 fps / p95 **16.8 ms** / 0 frames >100 ms; steady 60 fps /
  p95 16.8 ms. The motion-LOD choice closed the spike's NEAR-PASS p95 = 33.3 ms gap to a clean
  pass: this is the v0.4 deliverable meeting §3, and it confirms the decision
  (`docs/harness/canvas-perf.md`, ADR 0034).
- The card tier's perf is now contingent on motion-LOD staying in place; removing it would
  re-open the 33 ms p95 churn dip the spike measured.
- Parse-level caching and idle prebuild remain on the shelf as the next levers if a future
  card-tier regression fails the gates — to be reached for *before* re-introducing
  `content-visibility` (which is banned, ADR 0032).

## Sources

- `docs/canvas-vision.md` principle 5 (the standing mount-churn-amortization debt)
- `docs/specs/v0.4-canvas-mvp.md` §3 (motion-LOD; amended 2026-06-13; the element-level-cache
  rejection)
- `docs/research/2026-06-12-canvas-spike-results.md` §Numbers, §Verdict (cull NEAR-PASS:
  mean 51–56 fps, p95 33.3 ms, zero >100 ms)
- `docs/harness/canvas-perf.md` — the real-hardware verified verdict (card tier PASS)
- ADR 0032 (content-visibility retirement), ADR 0034 (the perf harness + measured verdict)
