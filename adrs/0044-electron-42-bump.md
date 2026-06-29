# 0044 — Bump Electron 39 → 42 (realign V8 with the pdf.js modern build)

Status: accepted (v0.6.1)

## Context

ADR 0043 (amendment, 2026-06-28) recorded an interim workaround: the renderer's pdf.js *value*
imports were forced onto the **legacy** build because `pdfjs-dist` v6's **modern** build calls
`Map.prototype.getOrInsertComputed` (TC39 "upsert", Stage 4 2026-01-20; unflagged baseline
**Chrome 145 / V8 14.5**), and pinned **Electron 39 (Chromium 142 / V8 14.2)** lacks it — so
`PDFPageProxy.render()` threw `TypeError: …getOrInsertComputed is not a function` in both the
renderer and worker realms and the canvas never painted. The legacy build self-polyfills via core-js
(~+364 KB) but is otherwise an identical surface. ADR 0043's "path back to modern" was: bump Electron
to realign the V8 baseline, then revert. **Issue #152** tracked this with its blast radius.

This ADR records that bump and its verified blast radius.

## Decision

**Bump `electron` (devDependency) `^39.2.6` → `^42.5.0`** (installed 42.5.0 — current latest stable).
Verified internals of the running binary (`process.versions`):

| field | Electron 39 (before) | Electron 42.5.0 (after) |
| --- | --- | --- |
| Chromium | 142 | **148**.0.7778.271 |
| V8 | 14.2 (no `getOrInsertComputed`) | **14.8**.178.33 (has it) |
| Node (bundled) | 22 | **24**.17.0 |
| ABI (`process.versions.modules`) | 135 | **146** |

`getOrInsertComputed` is unflagged from **Chrome 145 / V8 14.5** (ADR 0043); the first Electron past
that line is **E41 (Chromium 146 / V8 14.6)**, and E42 (V8 14.8) is comfortably past it — confirmed
empirically: the pdf render smoke now passes on the **modern** build (below).

**System Node stays 22.** electron@42.5.0 declares `engines.node >= 22.12.0` (verified via
`npm view`), and Electron bundles its **own** Node 24 for the app runtime; the dev/test toolchain
(vitest on system Node 22.22.3) is unaffected. No `@types/node`, `vite`, `electron-vite`
(stays `6.0.0-beta.1` — no stable 6.x; it is Electron-version-agnostic), or `@electron/rebuild`
change was needed.

**Renderer reverted to the modern build** (undoing ADR 0043's interim legacy swap):
- `src/renderer/src/pdf/usePdfDocument.ts`: value import `pdfjs-dist/legacy/build/pdf.mjs` →
  `pdfjs-dist`; worker URL `pdfjs-dist/legacy/build/pdf.worker.mjs` → `pdfjs-dist/build/pdf.worker.mjs`.
- `src/renderer/src/pdf/PdfReader.tsx`: `TextLayer` value import legacy → `pdfjs-dist`.
- Type-only imports were already on the package root (build-agnostic) — unchanged.
- **The main-process metadata path (`src/main/media/extract-pdf-metadata.ts`) stays on the legacy
  build** — it uses legacy for a *different* reason (Node no-DOM entry point at import time), not the
  V8 baseline, so it is unaffected by this bump.

**`font-src 'self' data:` is RETAINED** (not dropped). pdf.js loads embedded glyph fonts as
`data:font/woff2` URIs at the **engine** level — this is true on the modern build too, not a
legacy-build artifact. ADR 0043's interim note implied #152 would "drop `data:` again"; that is
wrong and is corrected here (and in `src/renderer/index.html`'s CSP comment). Dropping `data:` would
re-break embedded-font PDFs.

## Alternatives considered

- **Stay on Electron 39 + keep the legacy build.** Rejected: carries the permanent ~+364 KB core-js
  cost, keeps the renderer on a divergent build vs upstream's mainline, and forgoes 3 majors of
  Chromium/security/Node updates. The whole point of ADR 0043's interim was that this is temporary.
- **Bump only to Electron 41** (first with `getOrInsertComputed` unflagged). Rejected: 42 is the
  current latest stable and equally clears the V8 gap; taking the latest minimizes how soon the next
  bump is due and is the smaller long-term debt.
- **Keep `better-sqlite3` at 12.10.0.** Not viable — see Consequences (the native breaking change).

## Consequences

- **Native breaking change (the one real blast-radius item): `better-sqlite3` 12.10.0 does NOT
  compile against Electron 42's V8 headers.** `@electron/rebuild` failed with V8 API errors —
  `v8::External::Value()` now requires an isolate argument, and `SetNativeDataProperty` overloads
  became ambiguous (V8 14.x). Upstream fixed exactly this in **12.10.1** ("Fix V8 external API usage
  for Electron 42", PR #1475) and added the E42 prebuild target in **12.11.0/12.11.1**. **Resolved by
  bumping `better-sqlite3` to 12.11.1** (within the existing `^12.x` range; the package.json floor
  was moved `^12.10.0` → `^12.11.1` because 12.10.0 genuinely cannot build on E42 — leaving the floor
  at a non-compiling version would be a footgun). Rebuilds cleanly for both the Electron ABI
  (`rebuild:electron`) and the system-Node ABI (`rebuild:node`).
- **App-level (TS) blast radius: zero.** The full suite is green (133 files / 992 tests), typecheck
  is clean, and every Electron API used in `src/main` + `src/preload` (`app.*`, `BrowserWindow.*`,
  `ipcMain/ipcRenderer`, `contextBridge`, `session.fromPartition`, `protocol.handle`, `net.fetch`,
  `webContents.capturePage`/`setWindowOpenHandler`, `screen.*`, `shell.*`, `dialog`, `Menu`) is a
  stable, non-removed API on E42. No source change was required outside the pdf renderer revert.
- **Bundle: ~−364 KB** in the renderer (the core-js-polyfilled legacy build is no longer pulled in;
  the modern worker chunk is ~2.19 MB, loaded on-demand when a PDF opens).
- **Verified end-to-end under Electron 42 (Chromium 148):**
  - `smoke:pdf` PASSES on a freshly-built **modern** bundle (grep-confirmed: zero `legacy/build/pdf`
    refs; the worker calls `getOrInsertComputed` directly — the exact code that threw on E39). The
    canvas paints; selectable text layer builds.
  - A new **multi-feature fixture** (`tests/fixtures/multi-feature.pdf` — 3 pages, 3 embedded
    TrueType subsets → `data:font/woff2`, a JPEG image XObject) is rendered by a new QUATERNARY
    smoke assertion: paintedPx≈721k, distinctColors≈1940 — proving the embedded-font `data:font`
    path renders under the retained `font-src data:` CSP. **This closes #153's coverage gap.**
  - `smoke:thread` PASSES — the YouTube `<webview src=https://www.youtube.com/>` boots + renders on
    Chromium 148 and `webContents.capturePage` round-trips a PNG. (The YouTube **login** flow cannot
    be exercised headless — it still needs a one-off human check.)
- **`smoke:capture` fails — PRE-EXISTING, unrelated to this bump.** Its first gate injects a raw
  `<iframe src="youtube-nocookie.com">` + loads `youtube.com/iframe_api` as a script, both blocked by
  the current `script-src 'self'` / `default-src 'self'` CSP (the YouTube CSP tokens were removed in
  `13146cb` when YouTube became a `<webview>`, an ancestor of this branch). So the gate has been red
  since that migration, independent of Electron version; the capturePage path it guards is
  independently proven green by `smoke:thread`. Tracked for a follow-up to retire/convert the
  obsolete iframe gate.

## Sources

- `process.versions` of the installed `electron@42.5.0` (run 2026-06-28): chrome 148.0.7778.271,
  v8 14.8.178.33, node 24.17.0, modules 146
- `npm view electron@42.5.0 engines.node` → `>= 22.12.0`
- WiseLibs/better-sqlite3 releases: v12.10.1 ("Fix V8 external API usage for Electron 42", PR #1475),
  v12.11.0 (E42 build target, NOT viable), v12.11.1 (E42 Windows build fixes — adopted)
- `@electron/rebuild` failure log: `v8::External::Value()` arity / `SetNativeDataProperty` ambiguity
  against `~/.electron-gyp/42.5.0/include/node/v8-external.h`
- `adrs/0043-pdf-engine-pdfjs-dist.md` (the interim legacy swap + "path back to modern"); issue #152
  (this bump), issue #153 (multi-feature fixture coverage)
- `scripts/pdf-render-smoke.mjs` (PRIMARY + new QUATERNARY), `scripts/thread-smoke.mjs` (webview),
  `git log 13146cb` ("drop dead youtube CSP tokens — webview not iframe")
