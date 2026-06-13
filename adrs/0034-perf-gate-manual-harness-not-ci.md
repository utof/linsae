# 0034 — §3 perf gate as a manual, real-display Playwright-Electron harness — not a lefthook/CI gate

Status: accepted (v0.4)

## Context

The §3 performance gates (`docs/specs/v0.4-canvas-mvp.md` §3) are the card tier's acceptance
criteria — mean ≥ 55 fps, zero frames >100 ms, p95 ≤ 33.4 ms during mount churn, p95 ≤ 18 ms
steady, p95 ≤ 18 ms on the dev dot tier. The spike already established these are *measurable*; the
milestone-close question is **where** the measurement lives. The reflex is "make it a precommit
or CI gate so it can't regress." Two facts block that reflex (below), and a third set of facts —
discovered only by running the harness on real hardware — were needed before the verdict was
trustworthy at all.

## Decision

The §3 perf gate is a standalone **manual** script, `scripts/canvas-perf-harness.mjs`
(`pnpm harness:canvas`), run on a **real display** (never xvfb/ssh). It is **NOT** a lefthook step
and **NOT** a CI gate (`docs/harness/canvas-perf.md`). It:

1. launches the real prod-build app against a fresh tmp `--user-data-dir`;
2. seeds **500 notes via the app's own `window.api.canvas.createNoteAt` IPC** after launch;
3. `win.reload()`s so the remounted canvas re-reads all 500 committed rows (a raw IPC call does
   not invalidate the renderer's react-query cache);
4. asserts the board is non-empty (≥50 cards mounted — culling means not all 500 are in the DOM);
5. drives a **deterministic camera path** through an env-guarded control bridge
   (`window.__canvasHarness`, exposed only under `LINSAE_HARNESS=1`);
6. judges the §3 gates over **3 phases (churn / steady / dot) × 3 runs**, using the **median run
   by mean fps**.

### Why manual, not CI / lefthook

- **ABI.** The harness needs the **prod build (Electron ABI)** while vitest needs the **node
  ABI** — they cannot share the one `better-sqlite3` native binding in the same pipeline step
  (`docs/harness/canvas-perf.md` §Prerequisites).
- **Real GPU required.** The gate *requires* a real GPU/display: software GL (llvmpipe /
  swiftshader) invalidates the numbers, and the harness's **GPU guard aborts on it**. Headless CI
  gives software GL, so CI gating needs real-GPU runners — deferred and documented, not wired
  here (`docs/harness/canvas-perf.md` §Why no CI yet). The harness is run manually before
  milestone close; its verdict is **noted in the PR, not gated on**.

### Why an env-guarded control bridge (not gestures, not the dev HUD)

A deterministic camera **path** measures render cost spike-faithfully (gestures are
non-deterministic). The dev-HUD LOD store is **tree-shaken from prod**, so the harness can only
reach the dot tier via the bridge. The bridge is **inert in normal prod** — attached only under
`LINSAE_HARNESS=1` (`docs/harness/canvas-perf.md`).

### Why seed via `createNoteAt` IPC, not direct SQLite (B1 + B4)

- **B1 (tombstone):** the reconciler (`src/main/db/reconcile.ts`) is disk-driven and
  unconditionally soft-deletes any DB note with no `.md` file on disk — a direct-SQLite seed
  would be tombstoned at the next boot, leaving an empty board. `createNoteAt` is **file-first**
  (writes the `.md` then the row), so seeded notes survive reconcile.
- **B4 (ABI collision):** a Node-process `better-sqlite3` would ABI-collide with the launched
  Electron app over the one shared native binding. The IPC path goes through the app's own main
  process, which already owns the binding — so **the harness imports no `better-sqlite3` at all**
  (matching the morph/send harnesses) (`docs/harness/canvas-perf.md` §IPC-seed).

### Real-hardware corrections (necessary for a trustworthy verdict)

Three fixes were required before the numbers meant anything:

1. **`webContents.setBackgroundThrottling(false)`** from the main process — a backgrounded /
   occluded window throttles rAF to ~1 Hz, so the first measurements sampled **1.1 fps of
   garbage**.
2. The world div is a **0-size transform container**, so the runner waits for it `attached`, not
   `visible`.
3. A **dot-tier-flip post-condition** asserts cards unmount (count 0) after forcing the dot tier —
   else the dot gate silently measures the *card* tier (a false PASS, which actually occurred
   before the guard was added).

## Verified verdict (Quadro RTX 3000, 60 Hz, vsync 16.7 ms)

- **CARD tier PASSES** — churn 59 fps / p95 **16.8 ms** / **0** frames >100 ms; steady 60 fps /
  p95 16.8 ms. **The v0.4 deliverable meets §3.**
- **The DEV-ONLY dot tier FAILS** — 5.4 fps / p95 **533 ms**. Root cause: the production dot
  renderer (`src/renderer/src/canvas/CanvasStage.tsx`) draws 10k dots as one batched
  `beginPath()` → 10k `arc()` → single `fill()`, whereas the spike's validated benchmark
  (`scripts/spike-canvas/page/dots.js:37`) draws each dot as a cheap `fillRect(2×2)` and hit
  60 fps. **The harness — once corrected — caught this divergence.** It is a dev-only tier
  (not user-reachable without the HUD), tracked as a follow-up, and the harness is not a merge
  gate, so it does not block the milestone.

## Alternatives

- **A lefthook / CI gate** — rejected: the ABI split and software-GL-in-CI make it infeasible
  here; documented as a future step pending real-GPU runners.
- **Direct-SQLite seed** — rejected: B1 (reconcile tombstone) + B4 (ABI collision).
- **Driving via gestures or the dev HUD** — rejected: non-deterministic / tree-shaken from prod.

## Consequences

- The §3 gate is an **operator step run before milestone close**; the card tier is validated on
  reference hardware.
- The **dot-renderer perf divergence** (batched `arc()`+`fill()` vs `fillRect`) is tracked as a
  follow-up; it is dev-only and does not gate the milestone.
- The **if-free smoke flow** (`pnpm harness:canvas -- --smoke`) rides in for pixel-level
  interaction checks (drag/marquee/placement; #119/#121/#111) — a separate code path, not the
  perf gates.
- **CI gating is a documented future step** pending real-GPU runners; the harness already exits
  0/1 and `harness:canvas` is the stable entry point, so wiring it is config-only when such
  runners exist.

## Sources

- `docs/specs/v0.4-canvas-mvp.md` §3 (gate numbers), §12 (dot tier), §16, §17 (testing tiers),
  §19 (close-out)
- `scripts/canvas-perf-harness.mjs` — the harness
- `scripts/spike-canvas/page/dots.js:37` — the spike's `fillRect` dot renderer (60 fps)
- `src/renderer/src/canvas/CanvasStage.tsx:467` — the prod batched `arc()`+`fill()` dot renderer
- `docs/harness/canvas-perf.md` — run-doc + pinned protocol + "Why no CI yet"
- `docs/research/2026-06-12-canvas-spike-results.md` — baseline measurements + the DPMS-off/1 Hz
  throttle trap (the §Caveats "display must be awake")
- ADR 0033 (motion-LOD — the card-tier PASS it verifies), ADR 0024 (dev-tools HUD), ADR 0006
  (React Compiler — the first suspect on a FAIL)
