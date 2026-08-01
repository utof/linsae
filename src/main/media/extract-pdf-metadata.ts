// Main-side pdf.js metadata extraction. Uses the Node-friendly, no-DOM ESM
// entry point. NOTE: v6 is ESM-only — the path ends in .mjs (verified via
// context7 /mozilla/pdf.js + npm v6.0.227 tarball).
// @see adrs/0043-pdf-engine-pdfjs-dist.md
// @see adrs/0062-main-side-pdfjs-lazy-import.md

export interface PdfMetadata {
  title: string | null
  pageCount: number | null
}

/**
 * pdf.js, loaded on first use rather than at module scope.
 *
 * Why lazy, and why this cannot be a static import: the legacy build references
 * `DOMMatrix` at module scope. Electron's main process has no such global, so
 * pdf.js tries to polyfill from its OPTIONAL dependency `@napi-rs/canvas` and,
 * failing that, throws `ReferenceError: DOMMatrix is not defined` at import
 * time — killing main before any window opens. That optional dependency is
 * present in a dev `node_modules` but is NOT shipped by electron-builder, whose
 * node-module collector resolves the production dependency graph independently
 * of the `files` config. Net effect: `pnpm build` produced a binary that had
 * never once launched, while every dev run and every Playwright smoke passed,
 * because those resolve `@napi-rs/canvas` from disk.
 *
 * A static `import './pdfjs-node-globals'` placed above the pdf.mjs import does
 * NOT fix this, even though ES imports evaluate in source order: electron-vite
 * externalizes main's dependencies, and rolldown hoists every external
 * `require(...)` to the top of the emitted bundle — above the inlined module
 * body that would have installed the globals. Deferring the import to call time
 * is what actually orders them correctly. (Measured: the emitted require sat at
 * `out/main/index.js:35`, ahead of all inlined code.)
 *
 * Bonus: main no longer pays pdf.js's load cost at boot — only on first PDF
 * import.
 */
let pdfjsPromise: Promise<typeof import('pdfjs-dist/legacy/build/pdf.mjs')> | null = null
function loadPdfjs(): Promise<typeof import('pdfjs-dist/legacy/build/pdf.mjs')> {
  pdfjsPromise ??= import('./pdfjs-node-globals').then(
    () => import('pdfjs-dist/legacy/build/pdf.mjs'),
  )
  return pdfjsPromise
}

/**
 * Extract /Title metadata + page count from PDF bytes, main-side, no DOM.
 * Why main-side: the renderer's pdf.js path is the worker-based renderer;
 * metadata extraction at import time doesn't need rendering, so the legacy
 * no-worker entry point is lighter. Never throws on missing metadata —
 * returns nulls; callers fall back to filename.
 *
 * Why `new Uint8Array(bytes)`: callers pass `readFileSync(...)`, a Node
 * `Buffer`, and pdf.js v6 hard-rejects a Buffer ("provide binary data as
 * `Uint8Array`, rather than `Buffer`" — getDataProp at
 * node_modules/pdfjs-dist/legacy/build/pdf.mjs `val instanceof Buffer` guard).
 * A fresh full-span Uint8Array is guaranteed not to be a Buffer and copies the
 * (small, import-time) bytes once.
 */
export async function extractPdfMetadata(bytes: Uint8Array): Promise<PdfMetadata> {
  try {
    const pdfjs = await loadPdfjs()
    const loadingTask = pdfjs.getDocument({ data: new Uint8Array(bytes) })
    const doc = await loadingTask.promise
    let title: string | null = null
    try {
      const info = await doc.getMetadata()
      title = (info.info as { Title?: string } | null)?.Title ?? null
      if (title && title.trim() === '') title = null
    } catch {
      /* leave null */
    }
    const pageCount = doc.numPages
    await loadingTask.destroy()
    return { title, pageCount }
  } catch {
    return { title: null, pageCount: null }
  }
}
