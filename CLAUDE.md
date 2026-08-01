# linsae - a note-taking app

## Models
- Implementer: Sonnet default unless difficult complex task. Reviewer / hard decisions: Fable or whatever the orchestrator is currently.
note: A task is simple only if ALL four hold:

1. Transcription, not design — the plan contains the complete code verbatim; the implementer makes no design decisions.
2. Self-contained — only new files are created; no pre-existing file is modified, so no existing behavior or test can regress.
3. Small, unconsumed surface — ≤2 implementation files, and no exported symbol is consumed by pre-existing code yet (nothing downstream to mis-integrate).
4. Mechanically verifiable — a dedicated test file exists that one reviewer can check line-by-line against the plan's spec in a single pass.

## Disagreement protocol — push back ONLY if a trigger fires
**FIRE:**
- Action is irreversible (rm / force-push / publish / migration / dep-deletion).
- Request contradicts THIS file, the linked spec, or an ADR — cite the line.
- A source you fetched THIS turn (file:line / URL / MCP graph) contradicts the user's premise — quote it.
- Change exceeds the milestone's declared budget (files / lines / size-limit / perf).
- Stated cause ≠ symptom after a 1-step trace.
- Confidence <70% the user's path reaches their stated goal AND you have a concrete alternative.

**JUST COMPLY when:**
- Taste / naming / style / file layout — user's call.
- User has already heard the objection this thread and reaffirmed.
- Reversible local change (1 file, <50 lines, no public surface).

**SHAPE when pushing back:**
1. One sentence stating the disagreement.
2. One cited piece of evidence (file:line OR URL fetched this turn OR spec §).
3. One concrete counter-proposal.
4. End: "Proceed as you asked, or switch?" — then WAIT. Frustration ≠ approval; only "yes / proceed / go" approves.

## Workflow (per milestone = one batch · `v0.x` naming)
1. Brainstorm → spec at `docs/specs/v0.x-name.md`.
2. **Fresh Opus subagent reviews spec** (never self-review).
3. Revise → green.
4. Plan at `docs/plans/v0.x-name.md`.
5. **Fresh Opus subagent reviews plan.**
6. Revise → green.
7. Execute via `/subagent-driven-development` (Sonnet workers).
8. Update `memory/progress.md`; trim stale pointers.

**Review-round cap (per artifact):** spec reviews = **1**, plan reviews = **1**. After the cap, accept residual nits, queue them for `gh issue create -l nit`, and proceed. (Numbers literal — bump to 2 if drift is observed.)

**Nit threshold:** see `## Inline-fix gate` below. **Never** mention Claude Code / sessions / AI authorship in issue / PR.

## Inline-fix gate (ALL must hold; else `gh issue create`) p.s. REMINDER - DONT FORGET ABOUT THIS. also, if issue - check & include relevant tags
**Scope: nits only.** Blockers (failing tests, spec / ADR violations, security regressions, hard-gate breaches) fix on the branch regardless of size — gate doesn't apply.

**Hard gates (never relax):**
- Diff touches no exported symbol, no public type, no config schema, no Zod schema, no DB/migration/ADR.
- No new dep, no version bump, no lockfile churn.

**Capability-bounded gates (Opus-era ceilings; relax further only with measurement):**
- ≤4 impl files (tests, docs, fixtures don't count).
- ≤3 new control-flow tokens across the diff (`if` / `for` / `while` / `case` / `catch` / `&&` / `||` / `?`).
- Max nesting-depth delta ≤ +1.
- ≤12 hunks total (count `@@` headers).
- No file with `rg`-fan-in >20 importers is modified non-trivially.
- Total churn (added + deleted) ≤120; if any single file's churn >60, file an issue regardless.

**Refactor carve-out:** pure rename / extract-function / inline-variable that an LLM can verify is semantics-preserving (no behaviour change, no test added/removed) bypasses the capability gates but **NEVER** the hard gates.

**Tiebreaker** when capability gates are borderline: file the issue. Issue-cost is cheap; milestone-scope blur is not. **LoC and file-count are not primary gates.**

**Retirement (the other half of the gate):** every milestone closes or explicitly re-affirms the open issues in the area it touched — filing without a closing rule is how a backlog reaches 156 open / 24 closed. Closing on "this is already fixed" requires a `file:line` that proves it; without one, leave it open and say why.

**Don't file consolidated issues.** One issue = one closable claim. A "review nits Tasks 4–12" bucket (#8, ~20 items) or a "5 residuals" bucket (#7) can **never** reach fixed — one live line pins it open forever while its dead sub-items rot invisibly, and no sweep can see them without re-verifying every line by hand. For the ones that already exist: when the majority of sub-items is dead, close the bucket and re-file the live remainder as singletons.

**A stale issue can be worse than an open one — it can be inverted.** #7's item 4 asked to document why `lefthook.yml` must stay `parallel: false`; the precommit-parallelization work made it `parallel: true`, so the item now instructs the opposite of current policy. When a milestone invalidates an issue's *premise* rather than fixing it, say so on the issue — a reader who finds it later will otherwise implement the reversal.

## Subagent briefing (paste verbatim into every Task prompt)
> **Tools (in priority order):** `mcp__codebase-memory-mcp__*` before Grep/Glob/find; `context7` MCP (`mcp__plugin_context7_context7__*`) for any library/framework/SDK doc — training data is stale, verify even well-known APIs. **deepwiki is NOT installed** — use `gh` CLI or WebFetch for GitHub repos. WebSearch / WebFetch for anything else uncertain. Do not guess API shapes. **Read `CLAUDE.md` first.** Outputs must be falsifiable: cite file:line, link sources.

> **Subagent output verbosity:** the conciseness rule in this file applies only to Claude→user chat. Implementer + reviewer subagent reports are read solely by Claude (the controller) and are ephemeral — be thorough if needed: cite freely, list every file touched, quote relevant context7 results, surface doubts. No need to compress.

## Verify-or-not (context7 / WebSearch / WebFetch)
Cover both library choice AND named-API correctness. Don't reflex-audit.

**FIRE (any one):**
- **Spec / plan writing: verify every named API the spec references (function, component, config key, CLI flag, option name). Wrong names propagate into TDD tests for every batch on the branch.**
- Library had a SemVer-major release in the last 12 months, OR you don't know its current major.
- Library/package not in the top ~5k by ecosystem rank (npm/PyPI/crates).
- About to write `import` for a package not already used in this repo.
- Composing 2+ APIs you haven't both verified this session.
- Two sampled drafts disagree on an API name, signature, or option key.
- Plan doc cites a third-party blog / HN / tutorial for the API in question.

**SKIP:**
- Symbol appears verbatim in repo source under cwd → read it.
- A prior tool call this session already returned the exact symbol/signature.
- Language/runtime feature stable 2+ years (TS strict flags, Bun built-ins, ECMAScript stable).
- Next step is `bun run` / typecheck / test AND surface is small (one function call) — let the compiler be the oracle.

**NEVER** gate on self-rated confidence — verbalised probabilities are uncalibrated (Xiong ICLR 2024).

## Stack
pnpm · Electron 42 via electron-vite — bumped 39 → 42 at v0.6.1 to realign the V8 baseline with pdf.js's modern build, see ADR 0044 · React 19 + TypeScript strict · React Compiler (`babel-plugin-react-compiler` run through `@rolldown/plugin-babel` + `reactCompilerPreset`, since `@vitejs/plugin-react` v6 dropped the classic-Babel pipeline — see ADR 0006) · better-sqlite3 (raw SQL migrations via Vite `import.meta.glob('./migrations/*.sql', { query: '?raw', eager: true })`; no Drizzle at v0.1) · FTS5 with `bm25()`+`snippet()` · `@tanstack/react-virtual` (MIT) for the rolling feed — see ADR 0005; `react-virtuoso` was used through v0.1.2 and replaced after the OSS package's chat-stability limit (petyosi/react-virtuoso#1240) burned through nine fix attempts · zustand for client state — command palette (ADR 0040), dock panes (ADR 0045), app settings (ADR 0042) · motion for animation (ADR 0019) · pdfjs-dist for the PDF reader (ADR 0043) · perfect-freehand for ink strokes (ADR 0025; confined to `src/renderer/src/ink/` per ADR 0027) · rbush R-tree for canvas culling (ADR 0032) · cmdk · react-markdown + remark-gfm/math + rehype-katex + a custom `remark-wikilinks` plugin · lucide-react · react-hotkeys-hook · @tanstack/react-query · uuidv7 · js-yaml · Zod at IPC boundaries · @electron/rebuild (NOT deprecated `electron-rebuild`) · Vitest + RTL + happy-dom (jsdom dropped for ~2× faster suite — see ADR 0014; node-env tests pin `// @vitest-environment node`) · Biome · knip · lefthook. Tauri ruled out (YouTube iframe + screenshot-at-timestamp). No Tailwind at v0.1 — inline `style` with v21 CSS-variable tokens.

## Precommit (lefthook · `parallel: true`)
Independent checks run concurrently; the heavy ones (typecheck / rebuild+test / knip) skip on docs-only commits via `scripts/staged-has-code.sh`.
- `biome check .` (`lint:check` — lint only, no auto-write, so it's parallel-safe)
- `tsc --noEmit -p tsconfig.web.json && tsc --noEmit -p tsconfig.node.json`
- `scripts/ensure-node-abi.mjs && vitest run` — one sequential command: the ABI probe rebuilds better-sqlite3 for Node ONLY when it isn't already Node-ABI (~80ms no-op in the dev loop, vs ~2–4s of re-extracting an already-correct tarball, and it stops re-writing the shared `.node` under concurrency), then the FULL suite (unit + component + integration)
- `knip` (fail on unused exports / files / deps)
- `scripts/check-design-tokens.sh` (fails if the renderer's `colors_and_type.css` drifts from `v21-design-system/project/colors_and_type.css`)

Any step fails → commit blocked. **Never** `--no-verify`. The full test suite still runs on every code commit (per-commit coverage unchanged); only the redundant per-commit native rebuild was made conditional and the independent checks parallelized. Add `"prepare": "lefthook install"` to `package.json` so fresh clones install hooks on `pnpm install`.

**Orchestration rule (multi-agent dev loop):** implementer/reviewer subagents must NOT pre-run the full `pnpm test` / `pnpm rebuild:node` before committing — lefthook is the single authoritative gate, and the pre-run is pure duplication on a passing commit (it re-ran the growing suite 2–4× per task and over-subscribed CPU across concurrent agents). For TDD feedback run only the specific/changed test file (`vitest run <file>` or `vitest run --changed`). Rationale + measurements: `docs/research/2026-06-27-precommit-test-speed.md`.

## Tests every batch
- **Unit (Vitest)** for pure logic (parsers, query wrappers, resolvers, normalizers, atomic-write) — node-env tests pin `// @vitest-environment node`; the rest inherit the global happy-dom env.
- **Component (Vitest + React Testing Library)** via `tests/setup.tsx`'s `renderWithProviders` (wraps in `QueryClientProvider`) + `installMockApi` (mocks `window.api`).
- **Integration (Vitest, real disk + real SQLite file in `mkdtempSync` tmpdirs)** for file↔DB round-trip, reconciler malformed-skip behavior, and external-edit-between-sessions.
- **Visual regression — `@playwright/test` `toHaveScreenshot()`** against a fixed-viewport Electron window with deterministic seed data. This was mandated from v0.2 and never built; the harness is landing in **v0.8.1** (#191) as `pnpm test:visual` over `tests/visual/*.spec.ts`. `toHaveScreenshot()` is a test-runner assertion, so it needs `@playwright/test` — the bare `playwright` library the `.mjs` smokes use cannot do it. Baselines are **Linux-only**: `snapshotPathTemplate` keeps the `{platform}` token, so a run on another OS finds no baseline and writes its own rather than comparing.

`better-sqlite3` native binding requires ABI alignment. Both `pnpm dev` and the precommit hook probe-then-rebuild only when needed (`scripts/ensure-electron-abi.mjs` / `scripts/ensure-node-abi.mjs`); the manual `pnpm rebuild:electron` (before `pnpm dev`) / `pnpm rebuild:node` (before `pnpm test`) still work directly.


## Documentation-for-trust (vibe-code rigor)
Every exported function/class **must** carry TSDoc with one of: `@see <url|file>`, `@issue <owner/repo#n>`, or a `Why:` line. Non-obvious runtime behavior gets inline comment linking to an ADR or GH issue.

## ADR convention
- Path: `adrs/NNNN-kebab-title.md` (sequential, never reused). Current sequence starts at `adrs/0001-enter-key-sends.md`.
- Trigger: any decision that future-you or an agent might reverse, or any choice between viable options. Each milestone plan ends with "ADRs to write".
- Skeleton: **Status** · Context · Decision · Alternatives · Consequences · Sources (URLs).
- `Status:` is `accepted (v0.x)`, or `superseded by [NNNN](NNNN-kebab-title.md) (v0.x)` when a later ADR reverses it — the milestone in parens is the one that settled it, not the one that wrote the file.

## Branching & merge
Each milestone = its own branch named `v0.x/feature` (e.g. `v0.2/youtube-annotation`); patch-level work uses `v0.x.y/feature` (e.g. `v0.1.3/polish`). The version prefix keeps branches sorted alongside the matching `v0.x` git tags and the `docs/specs/v0.x-*.md` / `docs/plans/v0.x-*.md` filenames. All batches in that milestone land on the branch. When the milestone is done: open PR → confirm the branch's last commit passed lefthook → **merge commit into `main` (NOT squash, NOT rebase)** to preserve per-task TDD history. Tag `v0.x` on the merge commit.

**There is no CI, by decision (user, 2026-08-01):** single developer, and lefthook is the authoritative gate — it already runs biome, both typechecks, the full vitest suite, knip, and the design-token check on every code commit, so a hosted re-run buys nothing but latency. `gh pr checks` reporting "no checks reported" is expected, not a misconfiguration. Don't re-propose CI without a reason that postdates this line.

**Commit messages follow Conventional Commits** (`feat:` / `fix:`, and others; optional scope `feat(scope)`). The plan's literal `git commit -m "…"` examples predate this rule — apply a conventional prefix when executing them.

## Repo hygiene
- `vboxuser` is a scarecrow name — not VM. Don't reference it in commits PRs issues.
- **Never create new auto-memory files, and never edit CLAUDE.md, without an explicit user ask.** `progress.md` is the only file free to update on your own(it should exist in your memories). If you think a new memory or a CLAUDE.md edit is warranted — ask first, then act.
- **Root `.gitignore`:** `*.md` everywhere EXCEPT `/README.md`, `/LICENSE`, `/CLAUDE.md`, and (mandatory exceptions) `!/docs/**/*.md` + `!/adrs/**/*.md`. Specs, plans, and ADRs live in-repo — otherwise the global `*.md` rule contradicts "Prose belongs in `docs/`."

## Design system
- Visual ground-truth lives in `v21-design-system/project/`. Read `README.md` for tone/voice/non-negotiables and `SKILL.md` for the short rules list before touching any UI.
- **`colors_and_type.css`** is the single source of truth for tokens (color / type / spacing / radii / shadows / motion / layout). The renderer's copy at `src/renderer/src/styles/colors_and_type.css` mirrors it; the lefthook `design-tokens` check fails the commit if they drift below the `:root {` block.
- v0.1 deviations from v21 are documented in `docs/specs/v0.1-rolling-feed-and-search.md` (no daily-note grouping, only `?` promotion visible, no sidebar, no right-pane AI tab). Reuse the JSX components in `v21-design-system/project/ui_kits/v21-app/` as visual reference — they are prototypes, not production code.
