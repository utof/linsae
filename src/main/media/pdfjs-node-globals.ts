/**
 * Minimal `DOMMatrix` / `ImageData` / `Path2D` stubs for the main process, so
 * `pdfjs-dist/legacy/build/pdf.mjs` can be imported there.
 *
 * Why: the legacy build references `DOMMatrix` at module scope. In a browser
 * that global exists; in Node/Electron-main it does not, so pdf.js tries to
 * polyfill it from its OPTIONAL dependency `@napi-rs/canvas` and, failing that,
 * throws `ReferenceError: DOMMatrix is not defined` at import time — killing the
 * main process before any window opens.
 *
 * That optional dependency is present in a dev `node_modules` but is NOT shipped
 * by electron-builder, whose node-module collector resolves the production
 * dependency graph independently of the `files` config. The result was a
 * packaged app that had never launched: `pnpm build` produced a binary that
 * crashed at boot, while every dev run and every Playwright smoke passed,
 * because those resolve `@napi-rs/canvas` from disk.
 *
 * Why stubs rather than shipping `@napi-rs/canvas`: main does not render. Its
 * only pdf.js use is `getDocument` → `/Title` + `numPages`
 * (`extract-pdf-metadata.ts:13` — "no DOM… doesn't need rendering"), so a
 * multi-megabyte native canvas binding would ship solely to satisfy an
 * import-time reference that is never called. Rendering happens in the renderer,
 * which has the real browser globals.
 *
 * These are deliberately inert. If a future main-side code path actually needs
 * canvas geometry, it will fail loudly on a stub rather than silently mis-render
 * — which is the correct trade for a process that is not supposed to rasterize.
 *
 * MUST be imported before `pdfjs-dist` — ES module imports evaluate in source
 * order, so the `import './pdfjs-node-globals'` line has to stay above the
 * pdf.mjs import in `extract-pdf-metadata.ts`.
 *
 * @see adrs/0062-main-side-pdfjs-globals.md
 * @see docs/specs/v0.8.1-housekeeping.md §3.1
 * @see https://github.com/mozilla/pdf.js/issues/19406 (canvas optional-dep polyfill in the legacy build)
 */

/** Inert stand-in — pdf.js only needs the identifier to exist at module scope. */
class DOMMatrixStub {}

/** Inert stand-in; see the module doc for why a real implementation is wrong here. */
class ImageDataStub {}

/** Inert stand-in; see the module doc for why a real implementation is wrong here. */
class Path2DStub {}

const g = globalThis as Record<string, unknown>

// Assign only when absent: never shadow a real implementation (Electron may
// gain these in a future Chromium/Node baseline, and the real one must win).
g.DOMMatrix ??= DOMMatrixStub
g.ImageData ??= ImageDataStub
g.Path2D ??= Path2DStub

// Marks this file as an ES module rather than a global script. Without it,
// `tsc` reports TS2306 ("not a module") at the import site, since the file has
// no other import/export — it exists purely for its side effect.
export {}
