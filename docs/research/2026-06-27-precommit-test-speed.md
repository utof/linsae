# Precommit / test wall-clock — investigation & decisions (2026-06-27)

**Trigger:** during the v0.6 subagent-driven-development loop, the wall-clock gap between finishing one task and starting the next was growing "slower and slower." Question posed: are we doing something redundant / wrong, or is there a fundamentally better shape (the "faster horse" worry)? A dedicated analyst agent investigated (measured on the live box + forum research). Its full report is the appendix below; this section is the synthesis and what we decided.

## Synthesis

The waste was **duplication and concurrency, not the tests themselves.**

Measured per-gate cost (12-core box, Node v22.22.3): full `vitest run` ~24s (126 files / 971 tests, and growing every task), double `tsc` ~5s, `knip` ~2.4s, biome ~1.1s, `rebuild:node` ~2–4s — and that rebuild is a **cache-first no-op** (`prebuild-install` re-extracts an already-byte-correct tarball) that also re-writes the shared `better-sqlite3` `.node` every commit (a corruption hazard under concurrent agents).

Root causes of "slower and slower":

1. **Full suite ran 2× guaranteed, 3–4× typical, per task.** The controller had each implementer run `rebuild:node && typecheck && test` *before* committing, and then lefthook re-ran rebuild + typecheck + test + knip on the commit. On a passing commit the pre-run is 100% duplication. Cost grew as the suite grew → the perceived slowdown. (~48–96s/task of pure duplicate vitest.)
2. **Concurrency amplifier (likely the real culprit).** Each `pnpm test` spawns ~12 workers; multiple agents (implementer + reviewer + a concurrent task) each launching a 12-worker vitest on a 12-core box oversubscribes CPU 2–3× → runs inflate *super-linearly*.
3. `rebuild:node` no-op every commit; full-suite-per-commit instead of changed-file; double `tsc`; sequential hooks.

## Decisions (chosen: **orchestration fix + "safe config wins"**)

**A. Orchestration (controller behavior — no config change, no coverage change).** Implementer/reviewer subagents no longer pre-run the full `pnpm test` / `pnpm rebuild:node`. For TDD they run only the specific/changed test file (`vitest run <file>` / `vitest run --changed`) and let lefthook be the single authoritative full gate. Reviewers read the diff and don't re-run the full suite. Removes the 2–4× duplication and most of the concurrency oversubscription. Codified in CLAUDE.md ## Precommit ("Orchestration rule").

**B. Safe lefthook config wins (full per-commit coverage preserved):**
- **Conditional `rebuild:node`** via `scripts/ensure-node-abi.mjs` (inverse of the existing `ensure-electron-abi.mjs` predev probe): rebuild only when the binding isn't already Node-ABI → ~80ms no-op in the loop, and it stops re-writing the shared `.node` (kills the concurrency corruption race).
- **`parallel: true`** for the independent checks (biome `lint:check` is read-only, so no re-staging conflict); rebuild→test kept sequential inside one command.
- The **full test suite still runs on every code commit** — what's covered per commit is unchanged.

**Deliberately NOT taken (offered, declined): the "full fast-gate split."** Scoping per-commit tests to `vitest --changed` and moving the full suite to a pre-push/pre-PR gate would be the biggest win and the structural cure for suite-growth, but it shifts cross-cut-regression detection from per-commit to merge-time. We kept full per-commit coverage. (Recorded here in case we revisit if the suite gets large enough that even one run/commit hurts.)

## Net effect
Per-*task* heavy work drops from ~2–4× the full suite to ~1× (lefthook's single run), the rebuild no-op is gone, and the independent checks overlap — without changing what is verified on any commit. If the suite later grows enough that a single ~24s run/commit is itself the bottleneck, the "fast-gate split" (appendix §3/§4) is the next lever.

---

# Appendix — analyst report (verbatim)

> The following is the unedited report from the analysis agent. Measurements were taken read-only on the live box during the v0.6 loop and are labeled "measured (possibly contended)" vs "reasoned"; treat ±20%.

# linsae precommit/SDD wall-clock analysis

Read-only. No files changed, no rebuilds run. Measurements taken on the live box (12 cores, Node v22.22.3 ABI=127), labeled "measured (warm, lightly contended)" vs "reasoned". The concurrent task was not running a vitest at my sample instants (load 1.5–3.3), so numbers are near-clean but treat ±20%.

## 1. Where the time actually goes (per gate)

| Gate | Wall time | How obtained |
|---|---|---|
| `staged-has-code.sh` | ~5 ms | measured |
| `check-design-tokens.sh` | ~10 ms | measured |
| biome `lint:check` (whole repo) | **~1.1 s** | measured |
| `typecheck` (BOTH tsc, web+node) | **~5.2 s** | measured |
| `knip` | **~2.4 s** | measured |
| **full `vitest run`** (126 files / 971 tests) | **~24 s** | measured |
| `rebuild:node` | **~2–4 s (est)** | reasoned — see below |

Vitest internals (aggregate across 12 workers): `environment 277 s` (happy-dom init dominates), `import 62 s`, `transform 12.7 s`, `tests 25.8 s`. Wall is 24 s only because it parallelizes across all cores — which is exactly why it degrades under multi-agent concurrency (point 3).

**`rebuild:node` is NOT a compile and NOT a network call.** `pnpm rebuild:node` → better-sqlite3's `install` script → `prebuild-install`. I read its `download.js` (node_modules/.pnpm/prebuild-install@7.1.3/.../download.js:35-39): it is **cache-first** — if the cached tarball exists it unpacks it and never touches the network. Both tarballs are already cached on this box: `…better-sqlite3-v12.10.0-node-v127-linux-x64.tar.gz` AND `…-electron-v140-…`. So each `rebuild:node` is just `pnpm` orchestration + gunzip/untar of a 1 MB tarball → ~2–4 s. It is cheap, but it is **pure redundant work in the SDD loop** (re-extracts a binary that is already byte-correct) and it **writes the shared `.node`** every time (the corruption hazard you flagged).

## 2. Top redundancies, biggest first

**R1 — The full suite runs 2× guaranteed, 3–4× typical, per task.** This is the core waste.
- Implementer runs `rebuild:node && typecheck && test` (~32 s) *before* committing.
- `git commit` → lefthook re-runs rebuild + typecheck + **test** + knip + biome + tokens (~35 s).
- Reviewers sometimes run the suite (~24 s each).
On a **passing** commit the implementer's pre-run is 100% duplication of lefthook — it only ever saves time on a *failing* commit (avoids a doomed commit cycle). So mandating "implementer runs full suite then commits" guarantees 2× on the happy path. Concrete cost: vitest alone = 24 s × (2 to 4) = **48–96 s/task**, growing as the suite grows (971 tests now, smaller early — this is why "slower and slower").

**R2 — `rebuild:node` every code commit + in the implementer pre-run = 2×/task, and is a no-op.** You never run `pnpm dev` in the loop, so the binding stays Node-ABI; the rebuild re-extracts an identical binary. ~6 s/task wasted, plus it's the only writer to the shared `.node` — under concurrency two commits' rebuilds can race a third task's `test` mid-extract (your stated hazard is real).

**R3 — Full suite per commit instead of changed/related.** A typical SDD task touches 1–2 files; only a handful of test files are actually affected. Running all 126 files (24 s) where ~3–5 s of related tests would do is the structural waste.

**R4 — Double `tsc` 2×/task** (implementer + lefthook) = ~10 s. Non-incremental (`--noEmit -p` doesn't persist `.tsbuildinfo` despite `composite:true`), so every run re-checks everything.

**R5 — knip per commit** (2.4 s). Cheap, but it's a whole-project unused-export analysis — meaningful once the milestone surface is stable, not per file-commit.

## 3. The fundamentally better shape (the "faster horse" answer)

The current model — *one heavy gate, run fully, multiple times per task, by multiple concurrent agents* — is the anti-pattern. Forum consensus (sources below) is unanimous: **fast per-commit gate, full suite at a coarser boundary (pre-push / pre-merge / CI).** Recommended split:

- **Per-commit fast gate (target <10 s):** biome (staged files only) + `vitest run --changed` (only tests whose module graph touches the staged change) + design-tokens. Keep typecheck here (it's 5 s and catches cross-file type errors the scoped tests miss) — ideally incremental.
- **Pre-merge / pre-PR full gate (run once per milestone, which you already do at the whole-branch review):** full `vitest run` + knip + `rebuild:node` + double tsc.
- **CI on the PR already runs the full suite** — so per-commit full-suite is largely redundant with CI anyway.

**Coverage/safety tradeoff, honestly:** `vitest --changed` follows static imports only — a regression reachable only through a dynamic import or an untracked indirection won't run at commit time; it's caught at the pre-merge full gate + CI. Known caveat: vitest's `--changed` keys off changed *source* files and can miss a **test-only** change (vitest #1113) — for TDD where a task adds source+test together the source change pulls the test in via the graph, but a pure test edit could slip; mitigate by also passing staged `*.test.*` paths, or just lean on the full pre-merge gate. Net: you keep real safety (nothing merges without the full suite) while cutting per-commit latency ~5×.

## 4. Recommendations, ranked by impact ÷ effort

**1. (orchestration, ~0 effort, ~32 s/task) Stop the implementer's redundant `rebuild:node && typecheck && test` pre-run.** Change the subagent briefing so the implementer runs at most `vitest run --changed` for fast feedback and lets lefthook be the single authoritative gate. No safety loss — lefthook still blocks a bad commit; you only pay an extra cycle on the (minority) failing commits. Same for reviewers: review the diff, don't re-run the full suite (R1/F).

**2. (lefthook, low effort, ~3 s/commit + removes corruption race) Make `rebuild:node` conditional.** Mirror the existing `scripts/ensure-electron-abi.mjs` probe (~80 ms) with an `ensure-node-abi` probe that skips the rebuild when the binary is already Node-ABI — which it always is in the SDD loop. Turns ~3 s into ~80 ms and stops writing the shared `.node` unnecessarily. The existing predev script proves the probe pattern works.

**3. (lefthook, medium effort, ~20 s/commit) Scope per-commit tests to changed files.** Replace `pnpm test` in pre-commit with `vitest run --changed` (auto-detects staged+unstaged from git) or `vitest run related {staged_files}` via lefthook's native `{staged_files}` + `glob`. Move the full `vitest run` to a pre-push hook or a dedicated `pnpm gate:full` run at the pre-PR milestone review. Biggest single lever; tradeoff in §3.

**4. (lefthook, low effort, few s) `parallel: true` for the independent fast checks.** biome / typecheck / knip / design-tokens share no mutable state and can run concurrently (you use `lint:check`, not `--write`, so no staging conflict). Keep `rebuild → test` sequential (test needs the Node-ABI binary) as one piped command. Fast-gate wall becomes max() not sum().

**5. (low priority, ~4 s) Incremental typecheck** via `tsc -b` (writes `.tsbuildinfo`, only re-checks changed). 5 s is already cheap, so do this only if you keep typecheck in the per-commit gate and want it sub-second.

**6. (low priority) Move knip to the pre-merge full gate.** 2.4 s isn't worth optimizing for speed, but it belongs with the coarse gate semantically.

Combined effect: per-commit gate drops from ~35 s to roughly **biome 1 s ∥ typecheck 5 s ∥ knip(moved) + vitest-changed ~3–5 s + rebuild ~0.08 s ≈ 5–7 s**, and per-*task* gating drops from ~90–115 s to ~10–15 s, with the full suite still enforced once at pre-merge + CI.

## 5. Concurrency amplifier (likely the real "slower and slower")

Beyond suite growth: each `pnpm test` spawns ~12 workers. Two or three agents (implementer + reviewer + the other concurrent task) each launching a 12-worker vitest on a 12-core box oversubscribes CPU 2–3× → every run inflates **super-linearly**, not just additively. Recommendations 1+3 attack this directly (fewer, smaller runs). If you keep full runs concurrent, also cap `--maxWorkers`/`poolOptions` or serialize the gate across agents. The shared-`.node` rebuild race (rec 2) is the correctness half of the same concurrency problem.

## 6. Forum findings (consensus + dissent)

- **Pre-commit must be fast; full suites belong in CI/pre-push.** "Keep pre-commit under 30 s or developers bypass with --no-verify"; multi-gate model — Gate 1 unit+lint every commit, Gate 2 integration on PR, Gate 3 full regression on merge. https://switowski.com/blog/pre-commit-vs-ci/ , https://helpmetest.com/blog/cicd-testing-guide/ , https://nedspnt.medium.com/before-you-push-implementing-quality-gates-in-your-software-project-5d71645c72a0
- **Vitest scoping:** `vitest run --changed` (no value = uncommitted staged+unstaged) and `related`/relatedTests follow the static-import graph; designed for lint-staged/pre-commit use. https://vitest.dev/guide/cli , https://github.com/vitest-dev/vitest/discussions/1626 , https://github.com/vitest-dev/vitest/issues/280
- **Caveat (dissent/limitation):** `--changed` keys off changed source files and can ignore changed test files. https://github.com/vitest-dev/vitest/issues/1113
- **Lefthook native scoping** (no lint-staged needed): `glob:` + `{staged_files}` skips a command when nothing matches; `parallel: true` for independent checks; root/glob filters for monorepo-style scoping. https://github.com/evilmartians/lefthook , https://evilmartians.com/chronicles/5-cool-and-surprising-ways-to-configure-lefthook-for-automation-joy
- **@electron/rebuild / better-sqlite3 ABI:** rebuild is per-Electron-version and the recommended pattern is postinstall, not per-commit; confirms there's no need to rebuild on every commit when the runtime ABI hasn't changed. https://github.com/electron/rebuild/issues/886

## 7. Uncertainties + what would settle them
- **`rebuild:node` exact cost** is reasoned (~2–4 s), not measured (you forbade running it). Settle with `time pnpm rebuild:node` in isolation when no concurrent task is active.
- **vitest 24 s** was lightly contended; under real multi-agent concurrency the effective per-run cost is higher (see §5). Settle by timing a run while a second agent's suite is deliberately running.
- **`--changed` miss-rate** for this repo's TDD pattern is a judgment call; settle by trialing `vitest run --changed` on a few representative task diffs and diffing its selected files against the full set.
