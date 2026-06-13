# Canvas perf-gate harness — run-doc

`scripts/canvas-perf-harness.mjs` · `pnpm harness:canvas`

---

## What it is

The §3 perf gate for the v0.4 canvas-mvp milestone. It launches the **real
app** against a fresh tmp `--user-data-dir`, seeds 500 notes via IPC, reloads
the renderer so the canvas reads all 500 committed rows, then drives three
measured phases through the `window.__canvasHarness` bridge — all without any
`better-sqlite3` import in the harness process itself.

### Three phases and their §3 gates

| Phase | What happens | §3 gates |
|---|---|---|
| **churn** | Wide cosine pan across the full 5000×3300 world at zoom 1, so cards mount and unmount entering the viewport | meanFps ≥ 55 · p95 ≤ 33.4ms · zero frames >100ms |
| **steady** | Small ±60 px oscillation inside an already-mounted region (no new card mounts) | p95 ≤ 18ms |
| **dot** | `forceTier:'dot'` + 10 000 synthetic dots + unclamped zoom, then oscillate | p95 ≤ 18ms |

Each phase runs **3×**; the verdict uses the **median run by mean fps**
(the pinned protocol — see below).

> **Motion-LOD note:** churn/steady drive `setCamera` through the bridge → `moveCamera` → `bump()`, re-arming the 120 ms settle timer every frame, so `isMoving` stays **true** the whole phase — these phases therefore measure the §3-credited motion-LOD placeholder/amortization path, not full-Markdown cards (`NoteCard`'s `upgradedRef` latches once-upgraded, adding run-to-run nondeterminism).

### IPC-seed + reload + board-non-empty guard

The harness seeds via `window.api.canvas.createNoteAt` (the app's own IPC,
not a direct SQLite write). Two bugs rule out direct SQLite:

- **B1 (tombstone):** the boot reconciler (`src/main/db/reconcile.ts`) soft-
  deletes any DB note that has no `.md` file on disk. A DB-only seed is wiped
  on the very next launch. `createNoteAt` is file-first (writes
  `<userDataDir>/notes/<id>.md` before the DB row), so the reconciler never
  sees the notes as orphaned.
- **B4 (ABI collision):** the launched Electron app holds the
  `better-sqlite3` native binding at the Electron ABI. A separate Node
  process opening the same DB simultaneously would crash on the ABI mismatch.
  The IPC path goes through the app's own main process, which already owns
  the binding.

After seeding, a `win.reload()` is required: a raw IPC call does not
invalidate the renderer's react-query cache; the remounted canvas re-reads all
500 committed rows.

**Board-non-empty guard:** after seed + reload + switch to canvas the harness
counts `[data-note-id]` elements. Culling only mounts viewport-intersecting
cards, so not all 500 are in the DOM at once; the floor is 50. If fewer than
50 cards are mounted the harness aborts with:

```
FAIL: only N cards mounted after seed+reload — board empty/near-empty
      (seeding or reconcile failed?). Aborting before measuring.
```

**Log lines you will see during setup:**

```
gpu_compositing=enabled gl="Quadro RTX 3000/PCIe/SSE2" session=x11
vsync p50 ≈ 16.67ms
seeded 500 notes via createNoteAt IPC
mounted cards in viewport: 63 (floor 50)
```

---

## Prerequisites + how to run

**ONE prereq** (no `rebuild:node` — the harness imports no `better-sqlite3`):

```bash
pnpm rebuild:electron && pnpm exec electron-vite build
```

This builds the app at the Electron ABI. Do **not** run `pnpm dev` between
the build and the harness: `pnpm dev` rebuilds the renderer in dev mode, which
can shadow `out/` and make the launched app serve a dev-server renderer instead
of the production build.

**Run the perf gate (3-phase, 3-run, median verdict):**

```bash
pnpm harness:canvas
```

**Run the smoke flow (pointer interactions — drag/marquee/placement/#119/#121/#111):**

```bash
pnpm harness:canvas -- --smoke
```

---

## The pinned protocol (spec §3)

- **Machine state:** unattended idle machine, display awake and at 60 Hz.
- **GPU guard first:** the harness reads `app.getGPUFeatureStatus()` and
  `app.getGPUInfo('complete')`. If `gpu_compositing` is not `enabled`, or if
  the GL renderer string matches `llvmpipe` or `swiftshader` (software
  rendering), it aborts with exit 1:
  ```
  FAIL: GPU compositing not hardware-accelerated — results invalid (xvfb/ssh?).
  ```
- **Vsync probe second:** 61 rAF frames → median interval. If the median is
  outside **15–18ms** the harness aborts:
  ```
  FAIL: vsync p50 16.67ms outside 15–18ms — display not at 60Hz / awake. Aborting.
  ```
  This is a feature, not a bug. The "p95 ≤ 18ms" steady/dot gates are
  calibrated to 60 Hz; a 75 Hz or throttled/DPMS-off display makes the numbers
  meaningless. The v0.4.0 spike found that DPMS-off throttles rAF to ~1 Hz.
- **Mid-run throttle tripwire (#126):** the vsync probe only catches a display
  *already* asleep at start. If the screen DPMS-blanks **during** a phase, every
  run's median frame interval jumps to ~1000 ms (~1 Hz); the harness detects
  `p50 > 100ms` per run and aborts with the cause rather than a bogus
  "suspect React reconcile" verdict. Re-run with `xset -dpms s off` (restore after).
- **Run on a real display session, NEVER under xvfb or SSH:** software GL
  invalidates results. This is the same hard rule as the v0.1.3 morph harness
  and the spike harness.
- **3-run median:** each phase runs three times; the run with the median
  `meanFps` (middle when sorted ascending) is used for gate judging. This
  smooths one-off GC pauses.

---

## Interpreting the verdict

After the three phases the harness prints a markdown table (the median run)
followed by per-gate lines and a final verdict:

```
| phase  | meanFps | p50  | p95  | p99  | max   | >17ms   | >100ms |
|--------|---------|------|------|------|-------|---------|--------|
| churn  | 56.2    | 16.8 | 32.1 | 41.0 | 88.0  | 147/450 | 0      |
| steady | 60.1    | 16.6 | 17.2 | 18.1 | 22.0  | 12/480  | 0      |
| dot    | 60.0    | 16.7 | 17.0 | 17.8 | 19.0  | 8/480   | 0      |

PASS  churn meanFps ≥ 55
PASS  churn p95 ≤ 33.4
PASS  churn zero >100ms
PASS  steady p95 ≤ 18
PASS  dot p95 ≤ 18

VERDICT: PASS — §3 gates met on the median run
```

`VERDICT: PASS` means **all five checks passed** on the median run.

On a failure the line reads:

```
VERDICT: FAIL — below a §3 gate; suspect React reconcile first (profile; React Compiler is on)
```

**On FAIL, suspect React reconcile first** — profile in Chrome DevTools before
redesigning the geometry. React Compiler (ADR 0006) is already enabled; the
most common canvas culling failure mode is a reconcile storm on card mount
churn, not rendering cost.

The five gate checks (concrete):

1. `churn meanFps ≥ 55`
2. `churn p95 ≤ 33.4`
3. `churn zero >100ms` (the `>100ms` column must be 0)
4. `steady p95 ≤ 18`
5. `dot p95 ≤ 18`

---

## Smoke flow (`--smoke`)

`pnpm harness:canvas -- --smoke` runs a **separate code path** — it does NOT
run the perf gates. It reuses the same setup (launch + GPU/vsync guard + IPC
seed + reload + switch to canvas + board-non-empty guard) then drives real
Playwright pointer events to verify the Plan-3 interactions that happy-dom
cannot test:

| Assertion | Issue |
|---|---|
| drag-to-move: card lands ≈ drag delta and stays | §8 |
| no drag-commit flash: card never snaps back to origin post-up | #119 |
| marquee appeared mid-drag (`[data-canvas-marquee]`) | §8 |
| marquee selected ≥2 cards (selection ring on ≥2 shells) | §8 |
| dblclick-over-card opened in-place editor (`[data-canvas-card-editor]`) | #121 |
| dblclick-over-card did NOT create a card (count unchanged) | #121 |
| placement via double-click-create added a card (count +1) | §7 |
| canvas remounted after feed↔canvas toggle (world present) | #111 |
| dragged card still present after toggle (no abandonment) | #111 |
| no orphaned ghost after toggle (`[data-canvas-ghost]` count 0) | #111 |

Output per assertion: `OK  <label>` or `FAIL <label>`. Final line:

```
SMOKE VERDICT: PASS — all 10 assertions OK (#119 #121 #111 covered)
```

or

```
SMOKE VERDICT: FAIL — N/10 assertions failed: <labels>
```

---

## Why no CI yet

Spec §3 says "run manually + in CI where feasible." Headless CI environments
(GitHub Actions, etc.) use software GL (llvmpipe/swrast), which the GPU guard
rejects. Gating on real GPU runners requires self-hosted hardware with a
display session — feasible but not wired here. This is a **documented future
step**, not a gap: the harness already produces a machine-readable exit code
(0 = PASS, 1 = FAIL) and the `harness:canvas` npm script is the stable entry
point, so CI integration is a config-only addition when GPU runners are
available.

---

## See also

- `docs/specs/v0.4-canvas-mvp.md` §3 (gate numbers) · §7 (IPC seed) · §17
- `scripts/canvas-perf-harness.mjs` (the harness itself)
- `scripts/spike-canvas/run.mjs` (GPU guard + vsync probe; transcribed verbatim)
- `docs/research/2026-06-12-canvas-spike-results.md` (baseline measurements)
- ADR 0006 (React Compiler adoption)
