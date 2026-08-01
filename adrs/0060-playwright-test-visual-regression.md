# 0060 — `@playwright/test` for visual regression

Status: accepted (v0.8.1)

## Context

CLAUDE.md has mandated visual regression since v0.2 — *"Visual regression — Playwright
`toHaveScreenshot()` … starts at **v0.2**, deliberately deferred from v0.1"* — and it was never
built. Eight milestones shipped without it.

The reason it was never built is recorded in the plan that first skipped it:
`docs/plans/v0.2-youtube-annotation-2-capture-ipc-shell.md:32` — *"no `@playwright/test` dependency
is added (CLAUDE.md hard gate: no new dep)"*.

That reading was wrong. "No new dep" is a bullet under CLAUDE.md's **`## Inline-fix gate`**, whose
first line is *"**Scope: nits only.**"* The gate exists to stop a reviewer from smuggling a
dependency into a drive-by fix; it was never a prohibition on milestone deliverables, which are the
thing that adds dependencies. A mandate in one section was killed by a rule from another section
that did not apply to it, and nobody re-checked for six milestones.

`toHaveScreenshot()` is a **test-runner** assertion, not a library one. Playwright's own API docs are
explicit (context7, `/microsoft/playwright`, `class-locatorassertions.md`): *"Note that screenshot
assertions only work with Playwright test runner."* So the harness needs a runner, a config file, and
a spec directory — the three things this ADR adds.

## Decision

Add `@playwright/test` as a devDependency; add `playwright.config.ts` at the repo root, `tests/visual/`
with a shared `harness.ts` plus four `*.spec.ts` shots, and `pnpm test:visual` /
`pnpm test:visual:update`.

The bare-`playwright` `.mjs` smokes under `scripts/` (15 of them at time of writing) are **not**
migrated. Spec §4.1 floats that as "worth considering, not mandated": `@playwright/test` re-exports
`_electron`, so they could all switch and the second package could go away. That touches every one
of those working files and belongs in its own batch.

### A correction: the bare `playwright` package can, in fact, run the runner

Spec §4.1 says *"The bare `playwright` library this repo uses for its `.mjs` smokes cannot do it at
any effort."* **That is false**, and it is recorded here rather than quietly dropped because it was
the premise the whole section rested on.

Verified against the installed tree, not from memory:

- `node_modules/playwright/test.js` is `Object.assign(combinedExports.test, combinedExports)` over
  `require('./lib/index')` (the runner) merged with `require('./index')` (the library). The runner
  ships **inside** the `playwright` package: `node_modules/playwright/lib/runner/`,
  `lib/matchers/`, `lib/worker/`.
- `node -e "const t=require('playwright/test'); ..."` → `test: function  expect: function
  defineConfig: function  _electron: object`.
- `./node_modules/.bin/playwright test --version` exits 0.
- `node_modules/@playwright/test/index.mjs` is, in full, `export * from 'playwright/test';
  export { default } from 'playwright/test';`.

So `@playwright/test` is a **two-line re-export shim** over an entry point the repo already had. The
honest justification for adding it is not capability but convention: every Playwright doc, error
message, and example imports from `@playwright/test`, so a future reader who greps for the import
finds the canonical package, and a future `pnpm update` moves a package that is actually listed.
It costs ~5 KB and one dependency edge.

This does mean the "no new dep" objection was doubly wrong at v0.2 — the gate did not apply, *and*
the capability was already installed. Six milestones of missing coverage were bought for nothing.

### Versioning: same specifier **and** same resolved version

`@playwright/test@X` declares an **exact** dependency on `playwright@X` (verified:
`npm view @playwright/test@1.60.0 dependencies` → `{ playwright: '1.60.0' }`). If the two resolve
to different versions you get two `playwright` and two `playwright-core` installs with two browser
registries.

Spec §4.1 prescribes "the same specifier style on both (`^1.60.0` and `^1.60.0`, or exact and
exact)". **That rule is necessary but not sufficient, and following it verbatim reproduced the bug
it was written to prevent.** Adding `"@playwright/test": "^1.60.0"` next to the existing
`"playwright": "^1.60.0"` produced exactly this:

```
$ ls node_modules/.pnpm | grep '^playwright'
playwright@1.60.0
playwright@1.62.1
playwright-core@1.60.0
playwright-core@1.62.1
```

Both specifiers were identical carets. The skew came from the **lockfile**: `playwright` was already
locked at 1.60.0 and pnpm does not re-resolve an already-locked range, while the newly-added
`@playwright/test` resolved fresh to 1.62.1 and dragged `playwright@1.62.1` in behind it.

The sharpened rule, which is what this repo follows: **the two must share a specifier style AND
resolve to the same version in `pnpm-lock.yaml`.** Both are pinned at `^1.62.1`, and the lockfile is
the artifact to check:

```
  '@playwright/test':
    specifier: ^1.62.1
    version: 1.62.1
  playwright:
    specifier: ^1.62.1
    version: 1.62.1
```

Converging them bumped the pre-existing `playwright` devDep 1.60.0 → 1.62.1. That is a minor bump
within one major, and the only Playwright surface those `.mjs` smokes use is
`_electron.launch()` — which the four new specs exercise on 1.62.1 on every `pnpm test:visual`.

Consequence for maintenance: never bump one without the other, and after any bump re-check the
`ls node_modules/.pnpm | grep '^playwright'` output above. Two entries means the skew is back.

### Linux-only baselines

`snapshotPathTemplate` keeps the `{platform}` token:
`{testDir}/__screenshots__/{platform}/{testFileName}/{arg}{ext}`. Only `linux/` baselines are
committed.

Text rasterisation differs across operating systems — different font stacks, different hinting,
different subpixel strategies — so a macOS run compared against Linux bytes would fail on every
glyph and teach the developer that the harness is noise. With the platform in the path, a run on
another OS finds **no** baseline and writes its own instead of comparing. That is a documented
limitation, not a solution: a second developer on macOS gets no cross-platform guarantee, only a
local one. Given a single developer on Linux and no CI (see CLAUDE.md § Branching & merge), that is
the correct trade.

Within Linux the same argument applies one level down: a different distro with a different font
package would still differ. `maxDiffPixelRatio` absorbs antialiasing jitter, not a font
substitution.

### The thresholds are measured, and they are tighter than the spec assumed

Spec §4.3.3 expected font rendering to force "a non-zero `maxDiffPixelRatio` rather than
pixel-exactness". Non-zero, yes — but two orders of magnitude tighter than the ~0.5% a naive reading
suggests, because both ends of the range were measured rather than guessed:

| | measurement |
|---|---|
| noise floor | a full run at `maxDiffPixelRatio: 0` — **pixel-exact** — passed all four shots |
| regression signal | perturbing `--fg-0` to `#FFFFFF`: **7,203** px (thread), **17,091** (feed), **17,145** (pdf), **18,527** (canvas), of 1,024,000 |

That pixel-exact pass is a genuine run-to-run comparison — the baselines it matched were written by
an earlier run, in a separate process, against a separate throwaway profile — but it is **one**
comparison per shot, not a distribution. It establishes that the fixed vault, forced reduced-motion,
pinned locale/timezone, clock masks and fixed Xvfb screen leave nothing *systematically* moving; it
does not rule out rare jitter. The tolerance is insurance against exactly that: something plausible
but not yet observed, rather than anything measured.

`maxDiffPixelRatio: 0.0005` (512 px) is therefore the setting: above a floor of zero, and **14x
below the smallest observed regression**. The ~0.5% the spec implied would have left the thread shot
1.4x of margin — enough for a regression confined to one pane to slip through green.

Left deliberately non-zero rather than pixel-exact: a harness that fails on a single stray
antialiased pixel would be abandoned within a month, and the sensitivity given up between 0 and 512
pixels is not sensitivity to anything this harness is for.

### Masking the clocks rather than pinning a fake one

Spec §4.3.4 offers two ways to stop rendered timestamps from drifting: pin a fixed clock, or `mask`
the regions. We do both, in different places, and they are not redundant:

- **Seed timestamps are fixed constants in 2024** (`tests/visual/harness.ts`), written straight into
  the vault's frontmatter. This is not a fake clock — nothing overrides `Date.now()` — it is fixed
  *data*. It buys deterministic feed ORDER (`ORDER BY created_at DESC, rowid DESC`) and a stable day
  divider: `formatDayLabel` (src/renderer/src/lib/day.ts:43) only says "today"/"yesterday" for the
  last two days, so a 2024 stamp always renders the year-qualified locale date, which never changes.
- **`timeMasks()` masks the wall-clock labels anyway.** The thread shot's child notes *must* be
  created through `notes.create({ commentOn })` — a `comment-on` edge is DB-only and cannot be
  expressed in a vault file (`replaceLinksForNote` writes only `edge_type='reference'` and
  deliberately preserves `comment-on` across reconciles, src/main/db/queries/links.ts:37-48) — so
  main stamps their `created_at` with a live `Date.now()`. Their clocks drift by construction.

A fake clock (monkey-patching `Date.now` in the main process via `app.evaluate`) would have covered
that case too, and was rejected: it changes the behaviour of the thing under test. Timers,
react-query staleness, and the revision chain all read that clock, so a screenshot taken under a
frozen clock is a screenshot of an app that is not quite the app. The mask is local, changes
nothing, and costs four ~40x12px rectangles.

`locale: 'en-US'` + `timezoneId: 'UTC'` are passed to `_electron.launch()` regardless, so the day
dividers are pinned even though the clocks are covered.

## Alternatives

- **Do nothing / keep deferring.** The status quo for six milestones. Rejected: the "AI writes
  black-on-black" failure mode (`docs/specs/v0.1-rolling-feed-and-search.md:368`) is invisible to
  every other test in the suite — happy-dom does no layout and no painting, so a token that makes
  text unreadable passes unit, component, and integration tests unchanged.
- **Use the bare `playwright` package's runner without adding `@playwright/test`.** Technically
  sufficient (see the correction above). Rejected on convention: `import { test } from 'playwright/test'`
  is a spelling that appears in no Playwright documentation, and the dependency would be invisible
  in `package.json`.
- **Pin `@playwright/test` to exactly `1.60.0` and leave `playwright` at `^1.60.0`.** Yields a single
  install *today* with zero churn to the existing entry. Rejected: it is the mixed-style case spec
  §4.1 names explicitly — the next `pnpm update` floats `playwright` and leaves `@playwright/test`
  hard-requiring 1.60.0, re-creating the duplicate.
- **Screenshot the packaged app instead of `out/main/index.js`.** Rejected per spec §9.3: the
  harness is independent of §3's packaging work, and coupling them would make a visual failure
  ambiguous between "a token changed" and "the asar split broke something".
- **A large baseline set on day one.** Rejected per spec §4.4: more shots are cheap once the seeding
  helper exists, and an unmaintained baseline set is a liability before it is an asset. Four.

## Consequences

- `pnpm test:visual` is **not** in the lefthook gate. It builds, aligns the native ABI to Electron,
  and launches four real Electron apps — minutes, not seconds — and it leaves `better-sqlite3` on
  the Electron ABI, which the gate's own `ensure-node-abi.mjs` would then have to undo. It is a
  deliberate, manually-run check. The cost of that choice is that a token regression can be
  committed; it will be caught the next time the harness runs, not at the commit that caused it.
- The run is wrapped in `xvfb-run -a -s '-screen 0 1440x900x24'`. A fixed virtual screen with no
  window manager and a device scale factor of 1 is a much stronger determinism guarantee than
  whatever desktop happens to be logged in, and the baselines were generated under it. Running
  `playwright test` bare against a real desktop will produce diffs.
- `retries: 0` and `workers: 1` are load-bearing, not defaults. A retry would turn a flaky shot green
  and hide the one failure mode this harness must never develop.
- `tests/visual/harness.ts` is the reusable surface. A fifth shot is `launchSeeded()` + an assertion
  that the seeded content rendered + `toHaveScreenshot`.
- The `assertSeedRendered` call in each spec is not decoration. The reconciler **skips** a malformed
  vault file rather than throwing (src/main/db/reconcile.ts §malformed-skip), so a drift in the seed
  format would boot an app with an empty feed and `toHaveScreenshot` would cheerfully baseline the
  emptiness. That is precisely the vacuous-test class the v0.8 mutation sweep caught ten of.
- **The harness has been shown to go red.** Per spec §4.5 — *"a harness that has never gone red is
  not known to work"* — the acceptance run perturbed one token and all four shots failed with the
  pixel counts tabled above; the diff images flag every glyph on every surface. Reverting the token
  returned all four to green. Any future change to the thresholds, the masks, or the seeding helper
  should repeat that loop rather than trust that four `.png` files still mean something.

## Sources

- Playwright API — `toHaveScreenshot` is runner-only: https://playwright.dev/docs/api/class-locatorassertions#locator-assertions-to-have-screenshot-1
  (context7 `/microsoft/playwright`, `class-locatorassertions.md`)
- Playwright — `animations: 'disabled'` covers "CSS animations, CSS transitions, and Web Animations":
  https://playwright.dev/docs/api/class-page#page-screenshot (context7 `/microsoft/playwright`,
  `docs/src/api/params.md`)
- Playwright — Electron launch options (no `viewport`, no `reducedMotion`; `locale`/`timezoneId` are
  present): `node_modules/playwright-core/types/types.d.ts` `export interface Electron { launch(...) }`,
  and https://playwright.dev/docs/api/class-electron#electron-launch
- Playwright — snapshot path template tokens including `{platform}`:
  https://playwright.dev/docs/api/class-testconfig#test-config-snapshot-path-template
- `@playwright/test` depends on an exact `playwright`: `npm view @playwright/test@1.60.0 dependencies`
  → `{ playwright: '1.60.0' }`
- The v0.2 misapplication: `docs/plans/v0.2-youtube-annotation-2-capture-ipc-shell.md:32`
- The original motivation: `docs/specs/v0.1-rolling-feed-and-search.md:368`
- Spec: `docs/specs/v0.8.1-housekeeping.md` §4
- Issue: https://github.com/utof/linsae/issues/191
