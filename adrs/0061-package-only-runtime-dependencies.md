# 0061 — Package only the dependencies main actually requires at runtime

Status: accepted (v0.8.1)
Date: 2026-08-01

## Context

`pnpm build` produced an `app.asar` of **110 MB / 9,801 entries** for an app whose own bundled code
is ~7.7 MB. Measured by `@electron/asar`'s `listPackage`, the largest contributors were
`lucide-react` (3,962 entries), `motion` + transitives (~1,020), `@tanstack/*` (616), `katex` (231)
— all of which the renderer *already contains*, because Vite bundles them into `out/renderer`.

Two mechanisms were confused when this was first diagnosed, and the wrong one is the intuitive one:

**`electron-builder.yml`'s `files:` list does not govern `node_modules`.** Verified against
electron-builder's own source:

- `fileMatcher.ts` — when `files` patterns are configured, electron-builder *always injects*
  `!**/node_modules/**` into them; node modules "are handled separately."
- `nodeModulesCollector.ts` — node modules are collected by package-manager dependency-tree
  analysis, "**NOT** by walking the filesystem with user patterns." Only `dependencies` +
  `optionalDependencies` are considered, devDependencies excluded, "completely independently of the
  `files` config."

So adding `!node_modules/**` to `files:` would have been a silent no-op. The packaged tree is the
production **dependency graph**.

**What actually needs to ship.** `electron.vite.config.ts` applies `externalizeDepsPlugin()` to
`main` (`:14`) and `preload` (`:18`) — and deliberately **not** to `renderer` (`:20`). Main and
preload therefore `require()` their imports from `node_modules` at runtime; the renderer does not.
Confirmed in the emitted bundle (`out/main/index.js:27-35`: `require("better-sqlite3")`,
`require("uuidv7")`, `require("js-yaml")`, `require("zod")`,
`require("pdfjs-dist/legacy/build/pdf.mjs")`).

## Decision

Keep in `dependencies` exactly the five packages main/preload require at runtime — **better-sqlite3,
pdfjs-dist, js-yaml, uuidv7, zod** — and move every renderer-only package to `devDependencies`.
electron-builder then excludes them, and their transitive trees, automatically.

Separately, replace `files:`'s deny-list with an **allow-list** (`out/**`, `resources/**`,
`package.json`). This is where `files:` *does* apply, and the deny-list was leaking badly — see
Consequences.

Result: **110 MB / 9,801 entries → 49 MB / 1,517**.

## Alternatives

- **Re-include packages in `files:`** — a no-op for `node_modules`, per the source above.
- **`externalizeDepsPlugin({ exclude: [...] })`** so js-yaml/uuidv7/zod bundle into `out/main`,
  leaving only the two big externals. Viable and would shrink further, but it changes how main is
  built to solve a packaging problem, and `zod` (5.7 MB) is the only meaningful win.
- **Hand-maintained keep-list of `node_modules` paths** — cannot track transitive dependencies and
  rots silently. Rejected outright; it is the trap this ADR exists to document.
- **Subpath filtering inside the retained packages** (pdfjs-dist ships legacy *and* modern × min and
  unmin, plus `cmaps/` and `standard_fonts/`, while main imports only `legacy/build/pdf.mjs`).
  Genuine further win, deliberately **deferred** — correctness first.

## Consequences

- Renderer packages now sit in `devDependencies` while being genuine runtime deps *of the renderer*.
  This is standard for a bundled Electron renderer — `react` and `react-dom` were already there —
  but it is a real semantic compromise and is why this ADR exists.
- **Any future change to `files:` or to `dependencies` must be verified by launching the package**,
  not by inspecting the diff or the size. `pnpm smoke:packaged` exists for this and asserts the DB
  round-trips and main-side pdf.js loads. A size check alone cannot see the failure mode.
- The `files:` allow-list closed a **credential leak**: the old deny-list excluded only `src/` and
  the tsconfigs, so `adrs/`, `docs/`, `scripts/`, `tests/`, `memory/`, `v21-design-system/`, the
  agent-config dotdirs, `CLAUDE.md` **and `local_files/`** all shipped inside `app.asar` —
  and `local_files/` contains a YouTube cookies file, i.e. live session credentials. A deny-list is
  structurally unsafe here: anything later added to the repo root ships by default.
- Excluding `local_files/` does not break the dev cookie path: `src/main/yt-cookies.ts:24` resolves
  it from `process.cwd()` with a `YT_COOKIES_FILE` override, and cwd in a packaged app is the launch
  directory, never the asar.

## Sources

- https://github.com/electron-userland/electron-builder/blob/master/packages/app-builder-lib/src/fileMatcher.ts
- https://github.com/electron-userland/electron-builder/blob/master/packages/app-builder-lib/src/node-module-collector/nodeModulesCollector.ts
- https://www.electron.build/contents — Application Contents / default file inclusion
- `docs/specs/v0.8.1-housekeeping.md` §3.1
