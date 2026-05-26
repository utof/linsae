# linsae — agent instructions

*quick description of this note-taking app. warning - a lot of lines were copied from another project, so some links/paths might not make sense. mention if that's the case and we figure out the right words together*


## Models
- Implementer: **Sonnet** default unless difficult complex task. Reviewer / hard decisions: **Opus**.

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
- Reversible local change (single file, <50 lines, no public surface).
- You only have a vibe — no cited source, no spec conflict, no measurement.

**SHAPE when pushing back:**
1. One sentence stating the disagreement.
2. One cited piece of evidence (file:line OR URL fetched this turn OR spec §).
3. One concrete counter-proposal.
4. End: "Proceed as you asked, or switch?" — then WAIT. Frustration ≠ approval; only "yes / proceed / go" approves.

**NEVER:** opener flattery, hedge, list >2 alternatives, repeat an objection already overridden, defend after override.

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

**Nit threshold:** see `## Inline-fix gate` below. **Never** mention Claude Code / sessions / AI authorship in issue / PR / commit text.

## Inline-fix gate (ALL must hold; else `gh issue create -R utof/utofme -l nit`)
**Scope: nits only.** Blockers (failing tests, spec / ADR violations, security regressions, hard-gate breaches) fix on the branch regardless of size — gate doesn't apply.

**Hard gates (never relax — independent of model power):**
- Diff touches no exported symbol, no public type, no config schema, no Zod schema, no DB/migration/ADR.
- No new dep, no version bump, no lockfile churn.
- No public-network surface (env var / secret / route / cron / webhook) added or renamed.

**Capability-bounded gates (Opus-era ceilings; relax further only with measurement):**
- ≤4 impl files (tests / docs / fixtures don't count).
- ≤3 new control-flow tokens across the diff (`if` / `for` / `while` / `case` / `catch` / `&&` / `||` / `?`).
- Max nesting-depth delta ≤ +1.
- ≤12 hunks total (count `@@` headers).
- No file with `rg`-fan-in >20 importers is modified non-trivially.
- Total churn (added + deleted) ≤120; if any single file's churn >60, file an issue regardless.

**Refactor carve-out:** pure rename / extract-function / inline-variable that an LLM can verify is semantics-preserving (no behaviour change, no test added/removed) bypasses the capability gates but **NEVER** the hard gates.

**Tiebreaker** when capability gates are borderline: file the issue. Issue-cost is cheap; milestone-scope blur is not. **LoC and file-count are not primary gates.**

## Subagent briefing (paste verbatim into every Task prompt)
> **Tools (in priority order):** `mcp__codebase-memory-mcp__*` before Grep/Glob/find; `context7` MCP (`mcp__plugin_context7_context7__*`) for any library/framework/SDK doc — training data is stale, verify even well-known APIs. **deepwiki is NOT installed** — use `gh` CLI or WebFetch for GitHub repos. WebSearch / WebFetch for anything else uncertain. Do not guess API shapes. **Read `CLAUDE.md` first.** Outputs must be falsifiable: cite file:line, link sources.

> **Subagent output verbosity:** the conciseness rule in this file applies only to Claude→user chat. Implementer + reviewer subagent reports are read solely by Claude (the controller) and are ephemeral — be **thorough**: cite freely, list every file touched with SHAs, quote relevant context7 results, surface every doubt. Do not compress.

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
pnpm · Electron 30+ via electron-vite · React 19 + TypeScript strict · better-sqlite3 (raw SQL migrations via Vite `import.meta.glob('./migrations/*.sql', { query: '?raw', eager: true })`; no Drizzle at v0.1) · FTS5 with `bm25()`+`snippet()` · vanilla `Virtuoso` from `react-virtuoso` (MIT — NOT the commercial `VirtuosoMessageList`) · cmdk · react-markdown + remark-gfm/math + rehype-katex + a custom `remark-wikilinks` plugin · lucide-react · react-hotkeys-hook · @tanstack/react-query · uuidv7 · js-yaml · Zod at IPC boundaries · @electron/rebuild (NOT deprecated `electron-rebuild`) · Vitest + RTL + jsdom · Biome · knip · lefthook. Tauri ruled out (YouTube iframe + screenshot-at-timestamp). No Tailwind at v0.1 — inline `style` with v21 CSS-variable tokens.

## Precommit (lefthook · order matters)
1. `biome check --apply` (format + lint)
2. `tsc --noEmit -p tsconfig.web.json && tsc --noEmit -p tsconfig.node.json`
3. `vitest run` (unit + component + integration)
4. `knip` (fail on unused exports / files / deps)
5. `scripts/check-design-tokens.sh` (fails if the renderer's `colors_and_type.css` drifts from `v21-design-system/project/colors_and_type.css`)

Any step fails → commit blocked. **Never** `--no-verify`. Add `"prepare": "lefthook install"` to `package.json` so fresh clones install hooks on `pnpm install`.

## Tests every batch
- **Unit (Vitest, jsdom)** for pure logic (parsers, query wrappers, resolvers, normalizers, atomic-write).
- **Component (Vitest + React Testing Library)** via `tests/setup.tsx`'s `renderWithProviders` (wraps in `QueryClientProvider`) + `installMockApi` (mocks `window.api`).
- **Integration (Vitest, real disk + real SQLite file in `mkdtempSync` tmpdirs)** for file↔DB round-trip, reconciler malformed-skip behavior, and external-edit-between-sessions.
- **Visual regression — Playwright `toHaveScreenshot()`** against a fixed-viewport Electron window with seed data — starts at **v0.2**, deliberately deferred from v0.1.

`better-sqlite3` native binding requires ABI alignment: `pnpm rebuild:electron` before `pnpm dev`, `pnpm rebuild:node` before `pnpm test`. CI runs `rebuild:node` first.


## Documentation-for-trust (vibe-code rigor)
Every exported function/class **must** carry TSDoc with one of: `@see <url|file>`, `@issue <owner/repo#n>`, or a `Why:` line. Non-obvious runtime behavior gets inline comment linking to an ADR or GH issue.

## ADR convention
- Path: `adrs/NNNN-kebab-title.md` (sequential, never reused). Current sequence starts at `adrs/0001-enter-key-sends.md`.
- Trigger: any decision that future-you or an agent might reverse, or any choice between viable options. Each milestone plan ends with "ADRs to write".
- Skeleton: Context · Decision · Alternatives · Consequences · Sources (URLs).

## Branching & merge
Each milestone = its own branch named `phase/v0.x-name`. The `phase/` prefix is a literal sort key retained for stable branch ordering — it is not a workflow term (see `## Workflow`). All batches in that milestone land on the branch. When the milestone is done: open PR → CI green → **merge commit into `main` (NOT squash, NOT rebase)** to preserve per-task TDD history. Tag `v0.x` on the merge commit.

**Commit messages follow Conventional Commits** (`feat:` / `fix:` / `chore:` / `docs:` / `refactor:` / `test:` / `build:` / `perf:` / `ci:` / `revert:`; optional scope `feat(scope): …`). The plan's literal `git commit -m "…"` examples predate this rule — apply a conventional prefix when executing them.

## Repo hygiene
- `vboxuser` is a scarecrow name — not VM. Don't reference it in commits PRs issues; user's GitHub handle is `utof`.
- **Never create new auto-memory files, and never edit CLAUDE.md, without an explicit user ask.** `progress.md` is the only file free to update on your own(it should exist in your memories). If you think a new memory or a CLAUDE.md edit is warranted — ask first, then act.
- **Root `.gitignore`:** `*.md` everywhere EXCEPT `/README.md`, `/LICENSE`, `/CLAUDE.md`, and (mandatory exceptions) `!/docs/**/*.md` + `!/adrs/**/*.md`. Specs, plans, and ADRs live in-repo — otherwise the global `*.md` rule contradicts "Prose belongs in `docs/`."

## Design system
- Visual ground-truth lives in `v21-design-system/project/`. Read `README.md` for tone/voice/non-negotiables and `SKILL.md` for the short rules list before touching any UI.
- **`colors_and_type.css`** is the single source of truth for tokens (color / type / spacing / radii / shadows / motion / layout). The renderer's copy at `src/renderer/src/styles/colors_and_type.css` mirrors it; the lefthook `design-tokens` check fails the commit if they drift below the `:root {` block.
- v0.1 deviations from v21 are documented in `docs/specs/v0.1-rolling-feed-and-search.md` (no daily-note grouping, only `?` promotion visible, no sidebar, no right-pane AI tab). Reuse the JSX components in `v21-design-system/project/ui_kits/v21-app/` as visual reference — they are prototypes, not production code.