# Canvas Substrate Spike — Results (Stage 0 go/no-go)

Machine: gl="Nvidia 595.71.05 (gl=none,angle=none)" (Quadro RTX 3000, HW compositing via DRM; Chromium reports no GL/ANGLE context yet `gpu_compositing=enabled`) · session=x11 · dpr=1 · viewport=1280x774 · vsync p50=16.7ms (60Hz)
Harness: `scripts/spike-canvas/` @ 1b51dbb · 3 runs unattended on an idle machine with the display forced awake; representative table = run 2 (spread: cull and dots <1%; none ±16%, cv-all ±10% — noted, ranking unaffected) · plus one human-watched run 2026-06-12 (§Watched run below)

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
- operator observations (raster-side, invisible to rAF): recorded in the watched run below — **no raster artifacts** (no checkerboarding, blank flashes, or blurry tiles in any scenario).

## Watched run (2026-06-12, human-observed)

One run with the window frontmost and the operator watching (`pnpm spike:canvas | tee`). Display awake — dots p50=16.7 confirms real vsync.

| scenario | meanFps | p50 | p95 | p99 | max | >17ms | >100ms |
|---|---|---|---|---|---|---|---|
| cards {"mode":"none"} | 30.3 | 33.3 | 33.4 | 66.7 | 83.3 | 325/363 | 0 |
| cards {"mode":"cull"} | 51 | 16.7 | 33.4 | 50 | 66.7 | 91/612 | 0 |
| cards {"mode":"cv-all"} | 14.8 | 66.6 | 116.6 | 116.7 | 133.3 | 177/177 | 15 |
| cards {"mode":"cull+cv"} | 46.3 | 16.7 | 33.4 | 50 | 66.8 | 142/555 | 0 |
| dots {"dprCap":false} | 60 | 16.7 | 16.8 | 16.8 | 16.8 | 0/600 | 0 |
| dots {"dprCap":true} | 60 | 16.7 | 16.8 | 16.8 | 16.8 | 0/600 | 0 |

- Ranking identical to the unattended runs: cull > cull+cv > none > cv-all for cards; dots flawless 60fps both DPR modes (0 frames over 17ms — the dot tier's table is now operator-confirmed too: no raster-side surprises).
- Absolute numbers shifted: cull 51 vs 56 unattended (now below the 55 mean threshold too — see §Verdict), cull+cv 46.3 vs 41.6–43.9, none 30.3 vs 23.8–28.3, cv-all 14.8 vs 11.0–12.2. Cause untraced (operator-present desktop ≠ idle machine; single run); within the spread story, ranking unaffected.
- Operator report: no checkerboarding / blank flashes / blurry tiles anywhere. Perceived "laggy/freezy" scrolling through the dense card phases — consistent with the rAF table (none/cv-all jank is real and visible), nothing the table missed. No visual complaints during the dot scenarios.

## Ink (interactive, qualitative)

Filled 2026-06-12 from a human session (`pnpm spike:canvas --ink`, mouse only — pen untested).

- desynchronized: requested=false → actual=**false**; requested=true → actual=**true**, confirmed while actually drawing (HUD reads `getContextAttributes()`). Notable on Linux x11 + Nvidia; the research expected x11 support to be spotty.
- coalesced samples per pointermove (mouse): **7.44** with the synchronized context (2462 coalesced samples / 331 pointermove events) → the sync path MUST drain `getCoalescedEvents()` or lose ~87% of stroke fidelity. With desynchronized engaged the ratio collapses to **1.00** (3700/3699) — pointermove delivery becomes per-sample, ~11× the event rate, so the desync path receives full-rate input natively. (Observation only; the mechanism — desync opting the target out of rAF-aligned event coalescing — is untraced.)
- subjective latency on d-toggle: **no decisive difference** between the two states. Drawing felt slightly laggy in both; the operator's own calibration: ~2× lower latency would fall below their perception threshold. So desync *engages* here but is not by itself a perceptible win with a mouse on this stack — the canvas-ink milestone should treat it as a free flag to keep, not a feature to rely on.

## Verdict vs research thresholds

(Go/no-go criterion "60fps pan/zoom" from docs/research/2026-06-11-canvas-architecture-synthesis-v2.md
§Recommendations, operationalized by docs/plans/v0.4.0-canvas-spike.md §Measurement protocol item 5 —
PASS = meanFps ≥ 55, p95 ≤ 18ms, zero >100ms frames, against measured 60Hz vsync.)

- 500 mounted cards, no mitigation ('none' baseline): **FAIL** (24–28fps, p50 = exactly 2 vsyncs) — the raw DOM floor / Obsidian repro confirmed on this hardware.
- Culled card tier (~109 in-rect at z=1, ~225+ at zoom trough): **NEAR-PASS** — meanFps 56 ≥ 55 ✓, zero >100ms ✓, but p95 = 33.3ms ✗. (The single watched run came in at 51 mean — below the 55 bar too, still zero >100ms; cause untraced, ranking unchanged. Reinforces, not changes, the conclusion.) The dips are clean single missed vsyncs (every bad frame is exactly 2×16.7ms — no chaotic stalls), concentrated where cards enter (KaTeX build + append) and at the zoom trough. → Consequence: the card-mode ceiling roughly holds but needs mount-churn amortization in the milestone (idle-time card prebuild, KaTeX render cache, or motion-LOD: cheap placeholder during pan, full card on settle — research "DOM struggles below 500" branch). Decision belongs to the canvas spec.
- Best mitigation vs 'none' baseline: **cull, alone**. content-visibility is actively harmful under an animated scale transform: cv-all runs at 11–12fps with 42–44 frames >100ms (style/layout re-evaluation of 500 cv boundaries every zoom frame — far worse than just painting them), and cull+cv is strictly worse than cull (cvSkipped=0: pure overhead, no skipping). **Retire content-visibility from the canvas plan.** (The exact mechanism — relevance re-determination vs containment-boundary cost per frame — is untraced; cull+cv losing 14fps to plain cull with zero state churn isolates a real per-boundary carrying cost. It is *expected* to remain fine for non-transformed scroll contexts like the feed — unmeasured here, do not cite this doc as evidence for that.)
- 10k dots @ 60fps on canvas 2D: **PASS, flawless** (p95 = vsync, zero frames over 17ms across all runs including the watched one, full 10k drawn at the zoom trough; operator-confirmed — no raster artifacts) → canvas 2D suffices for the far tier at v0.x; WebGL escalation not needed at this scale.
- DPR cap effect: **no delta — untestable**, the display ran at dpr=1 (fractional scaling not active during these runs). Re-measure if/when a fractional-DPR display is in play; keep the trick on the shelf, unproven here.
- desynchronized on this platform: **available, confirmed interactively** (actual=true while drawing) — but subjectively NOT a perceptible latency win with a mouse (see §Ink). Keep the flag for the canvas-ink milestone; don't bank on it. The load-bearing ink finding is instead the coalescing behavior: sync contexts need `getCoalescedEvents()` drained (7.44 samples/move), desync contexts get full-rate events.

## Caveats

- Vanilla DOM cards: numbers are the substrate floor; React adds reconciliation
  overhead on top (mitigable: memo, React Compiler — research §6).
- rAF intervals measure main-thread frame pacing only; raster/compositor-side
  delays are covered only by the operator pass (it systematically flatters
  cv-all/none). The operator pass happened 2026-06-12: no raster artifacts in
  any scenario (§Watched run) — one run, one operator.
- Ink subjective data is mouse-only, single-operator, single session; pen/stylus
  untested.
- **Display must be awake**: with the monitor DPMS-off there is no vsync and
  Chromium throttles rAF to ~1Hz — early unattended runs produced 1000ms
  intervals until the display was forced on (`xset dpms force on`). Any future
  run on this protocol must verify the printed `vsync p50` is ~16.7ms, not
  ~1000ms, before trusting the table.
- Fixed 200px card height; real cards have variable height (more layout work).
- Single hardware point (Quadro RTX 3000, 60Hz, dpr=1); thresholds re-check on
  any other target machine.
