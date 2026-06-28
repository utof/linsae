// Main-side pdf.js metadata extraction. Uses the Node-friendly, no-DOM ESM
// entry point. NOTE: v6 is ESM-only — the path ends in .mjs (verified via
// context7 /mozilla/pdf.js + npm v6.0.227 tarball).
// @see adrs/0043-pdf-engine-pdfjs-dist.md
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'

export interface PdfMetadata {
  title: string | null
  pageCount: number | null
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
