# 0062 — Load main-side pdf.js lazily, behind DOMMatrix stubs

Status: accepted (v0.8.1)
Date: 2026-08-01

## Context

While verifying ADR 0061's packaging change by actually launching the packaged binary, the app was
found to crash at main-process boot:

```
Warning: Cannot load "@napi-rs/canvas" package: "Error: Cannot find module '@napi-rs/canvas'"
Warning: Cannot polyfill `DOMMatrix`, rendering may be broken.
Uncaught Exception:
ReferenceError: DOMMatrix is not defined
    at app.asar/node_modules/pdfjs-dist/legacy/build/pdf.mjs:16982:22
```

`pdfjs-dist/legacy/build/pdf.mjs` references `DOMMatrix` at module scope. Browsers have it; Electron
**main** does not. pdf.js therefore tries to polyfill from its **optional** dependency
`@napi-rs/canvas` and, failing that, throws at import time.

That optional dependency resolves fine from a dev `node_modules` (it is in the pnpm store at
`@napi-rs+canvas@1.0.1`) but is **not shipped** by electron-builder, whose node-module collector
resolves the production graph independently of `files` (ADR 0061).

**This was pre-existing and unrelated to ADR 0061's change.** `pdfjs-dist` was in `dependencies`
before and after, so `@napi-rs/canvas` was equally absent from earlier builds. The packaged app had
**never launched**. It went unnoticed because:

- every dev run and every Playwright smoke launches `out/main/index.js` with the repo's
  `node_modules` on disk, where `@napi-rs/canvas` resolves — so all of them passed;
- an uncaught main-process exception makes Electron show an error dialog and **keep the process
  alive**, so a naive "did it exit?" check reads as success.

Only asserting on a rendered window caught it.

## Decision

Import pdf.js in main **lazily, on first use**, behind a module that installs inert `DOMMatrix` /
`ImageData` / `Path2D` globals (`src/main/media/pdfjs-node-globals.ts`).

Stubs rather than shipping `@napi-rs/canvas`: main does not render. Its only pdf.js use is
`getDocument` → `/Title` + `numPages` (`extract-pdf-metadata.ts` — "no DOM… doesn't need
rendering"). Shipping a multi-megabyte native canvas binding to satisfy an import-time reference
that is never called is the wrong trade. Rendering happens in the renderer, which has the real
globals.

**Lazy is load-bearing, not a nicety.** A static `import './pdfjs-node-globals'` placed *above* the
pdf.mjs import does **not** work, despite ES imports evaluating in source order: electron-vite
externalizes main's dependencies and rolldown hoists every external `require(...)` to the top of the
emitted bundle, above the inlined module body that installs the globals. Measured — the emitted
`require("pdfjs-dist/legacy/build/pdf.mjs")` sat at `out/main/index.js:35`, ahead of all inlined
code. This was tried, shipped to a package, and observed still crashing before the lazy form was
adopted.

## Alternatives

- **Add `@napi-rs/canvas` to `dependencies`.** Works, but ships a large native binding for
  functionality main never invokes, partly undoing ADR 0061.
- **Switch main to the modern build** (`pdfjs-dist/build/pdf.mjs`). ADR 0043 chose legacy because
  Electron 39's V8 lacked `Map.getOrInsertComputed`; on Electron 42 (ADR 0044) this may no longer
  apply and would be the cleaner long-term answer. Not taken here: it is a real engine change
  needing its own verification, inside a chore batch. Worth revisiting — see #152.
- **Real `DOMMatrix` implementation.** More code to maintain for a process that must not rasterize;
  an inert stub fails loudly if a future main path genuinely needs geometry, which is the safer
  failure.

## Consequences

- Main no longer loads pdf.js at boot — only on first PDF import. Faster startup, smaller boot
  surface.
- The globals are assigned with `??=`, never shadowing a real implementation should Electron's
  baseline gain them.
- **A boot-only test no longer covers this.** Because the import is deferred, a broken pdf.js load
  now surfaces at first PDF import rather than at launch. `scripts/packaged-app-smoke.mjs`
  accordingly asserts on a real `window.api.pdf.import(...)` returning the correct `pageCount`,
  not on module resolution.
- Generalizable lesson, recorded because it cost real time: **"the process is still alive" is not
  evidence that an Electron app booted.** Assert on a rendered window.

## Sources

- `src/main/media/pdfjs-node-globals.ts`, `src/main/media/extract-pdf-metadata.ts`
- `adrs/0043-pdf-engine-pdfjs-dist.md` (why the legacy build), `adrs/0044-electron-42-bump.md`
- `adrs/0061-package-only-runtime-dependencies.md`
- pdfjs-dist `package.json` — `optionalDependencies: { "@napi-rs/canvas": "^1.0.0" }`
