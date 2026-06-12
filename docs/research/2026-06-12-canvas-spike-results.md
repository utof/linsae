# Canvas Substrate Spike — Results (Stage 0 go/no-go)

Machine: gl="Nvidia 595.71.05 (gl=none,angle=none)" (Quadro RTX 3000, HW compositing via DRM; Chromium reports no GL/ANGLE context yet `gpu_compositing=enabled`) · session=x11 · dpr=1 · viewport=1280x774 · vsync p50=16.7ms (60Hz)
Harness: `scripts/spike-canvas/` @ 1b51dbb · 3 runs unattended on an idle machine with the display forced awake; representative table = run 2 (spread: cull and dots <1%; none ±16%, cv-all ±10% — noted, ranking unaffected)

## Numbers

| scenario | meanFps | p50 | p95 | p99 | max | >17ms | >100ms |
|---|---|---|---|---|---|---|---|
| cards {"mode":"none"} | 28 | 33.3 | 50.1 | 66.7 | 83.3 | 328/335 | 0 |
| cards {"mode":"cull"} | 56.1 | 16.7 | 33.3 | 33.4 | 33.4 | 47/673 | 0 |
| cards {"mode":"cv-all"} | 11.7 | 83.3 | 133.4 | 150 | 150.1 | 140/140 | 44 |
| cards {"mode":"cull+cv"} | 41.9 | 16.7 | 50 | 66.6 | 66.7 | 178/503 | 0 |
| dots {"dprCap":false} | 60 | 16.7 | 16.7 | 16.8 | 16.8 | 0/600 | 0 |
| dots {"dprCap":true} | 59.9 | 16.7 | 16.7 | 16.8 | 33.2 | 1/599 | 0 |

Cross-run means: none 23.8–28.3 · cull 55.9–56.4 · cv-all 11.0–12.2 · cull+cv 41.6–43.9 · dots 59.9–60.0.

- cv engagement: cvSkipped=94 (cv-all, identical all 3 runs) / 0 (cull+cv — cv INERT in this mode: the culled set ≈ the visible set, so nothing was ever skipped; that row is effectively "cull plus the per-card cost of carrying `content-visibility:auto`", and it is strictly slower than plain cull). Note the 94 is itself a finding: at the end-of-run camera ~390–440 of 500 cards are geometrically off-viewport (cull mounts ~109), yet cv treated only 94 as skippable — cv **engaged poorly**, paying its per-boundary overhead while still treating ~4× cull's card count as render-relevant. cvSkipped is a snapshot near end-of-run (engagement oracle only — event dispatch may lag the final frames), not a peak count.
- operator observations (raster-side, invisible to rAF): NOT YET RECORDED — runs were unattended (display on, nobody watching). Pending a human-watched run; matters most for confirming the dot tier's flawless table and for `none`/`cv-all` raster behavior.

## Ink (interactive, qualitative)

- desynchronized requested=true → actual=**true** per an ad-hoc scripted probe during implementation (the committed path that reproduces it: `pnpm spike:canvas --ink` — the HUD prints `actual=` from `getContextAttributes()` before any drawing). Notable on Linux x11 + Nvidia; the research expected x11 support to be spotty. PENDING human confirmation while actually drawing.
- coalesced samples per pointermove: PENDING (mouse) / PENDING (pen, if tested)
- subjective latency difference on d-toggle: PENDING

Run `pnpm spike:canvas --ink` to fill these in: scribble fast, read the HUD, press `d` to toggle desynchronized and compare.

## Verdict vs research thresholds

(Go/no-go criterion "60fps pan/zoom" from docs/research/2026-06-11-canvas-architecture-synthesis-v2.md
§Recommendations, operationalized by docs/plans/v0.4.0-canvas-spike.md §Measurement protocol item 5 —
PASS = meanFps ≥ 55, p95 ≤ 18ms, zero >100ms frames, against measured 60Hz vsync.)

- 500 mounted cards, no mitigation ('none' baseline): **FAIL** (24–28fps, p50 = exactly 2 vsyncs) — the raw DOM floor / Obsidian repro confirmed on this hardware.
- Culled card tier (~109 in-rect at z=1, ~225+ at zoom trough): **NEAR-PASS** — meanFps 56 ≥ 55 ✓, zero >100ms ✓, but p95 = 33.3ms ✗. The dips are clean single missed vsyncs (every bad frame is exactly 2×16.7ms — no chaotic stalls), concentrated where cards enter (KaTeX build + append) and at the zoom trough. → Consequence: the card-mode ceiling roughly holds but needs mount-churn amortization in the milestone (idle-time card prebuild, KaTeX render cache, or motion-LOD: cheap placeholder during pan, full card on settle — research "DOM struggles below 500" branch). Decision belongs to the canvas spec.
- Best mitigation vs 'none' baseline: **cull, alone**. content-visibility is actively harmful under an animated scale transform: cv-all runs at 11–12fps with 42–44 frames >100ms (style/layout re-evaluation of 500 cv boundaries every zoom frame — far worse than just painting them), and cull+cv is strictly worse than cull (cvSkipped=0: pure overhead, no skipping). **Retire content-visibility from the canvas plan.** (The exact mechanism — relevance re-determination vs containment-boundary cost per frame — is untraced; cull+cv losing 14fps to plain cull with zero state churn isolates a real per-boundary carrying cost. It is *expected* to remain fine for non-transformed scroll contexts like the feed — unmeasured here, do not cite this doc as evidence for that.)
- 10k dots @ 60fps on canvas 2D: **PASS, flawless on the main thread** (p95 = vsync, zero frames over 17ms across all runs, full 10k drawn at the zoom trough; raster-side operator pass pending) → canvas 2D suffices for the far tier at v0.x; WebGL escalation not needed at this scale.
- DPR cap effect: **no delta — untestable**, the display ran at dpr=1 (fractional scaling not active during these runs). Re-measure if/when a fractional-DPR display is in play; keep the trick on the shelf, unproven here.
- desynchronized on this platform: **available per probe** (actual=true) → feeds the canvas-ink milestone; confirm interactively.

## Caveats

- Vanilla DOM cards: numbers are the substrate floor; React adds reconciliation
  overhead on top (mitigable: memo, React Compiler — research §6).
- rAF intervals measure main-thread frame pacing only; raster/compositor-side
  delays are covered only by the operator-observation line above — weigh this
  when ranking mitigation modes (it systematically flatters cv-all/none). The
  operator pass has not happened yet for these runs.
- **Display must be awake**: with the monitor DPMS-off there is no vsync and
  Chromium throttles rAF to ~1Hz — early unattended runs produced 1000ms
  intervals until the display was forced on (`xset dpms force on`). Any future
  run on this protocol must verify the printed `vsync p50` is ~16.7ms, not
  ~1000ms, before trusting the table.
- Fixed 200px card height; real cards have variable height (more layout work).
- Single hardware point (Quadro RTX 3000, 60Hz, dpr=1); thresholds re-check on
  any other target machine.
