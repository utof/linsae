/**
 * Playwright-Electron smoke for the v0.6 PDF slim slice (Task 15).
 * Launches the BUILT app (served over the http://127.0.0.1 loopback shell) and
 * verifies, end-to-end, that REAL pdf.js renders a page and its text is
 * selectable — the three things no unit/integration test can reach (nothing in
 * the suite renders pdf.js; happy-dom has no 2D context — spec §9 locked
 * decision):
 *
 *   PRIMARY   — the pdf.js worker boots under `sandbox:true` + contextIsolation
 *               (src/main/security.ts) and the §5 CSP (`worker-src 'self' blob:`)
 *               and PAINTS a non-trivial canvas. Closes round-2 R1/R2
 *               (blob-worker boot + CSP sufficiency). A bare `c.width > 0` check
 *               is a false positive — an unrendered <canvas> defaults to 300×150
 *               — so this also asserts real PAINT (opaque pixels) and CONTENT
 *               (>1 distinct color).
 *   SECONDARY — the loopback shell serves the .pdf with `application/pdf`
 *               (verifies Task 6's MIME addition; src/main/http-shell.ts:50).
 *   TERTIARY  — the text layer rendered selectable spans and a real DOM
 *               selection over them yields a non-empty quote (spec §8 / round-2
 *               review B5) — the only end-to-end proof excerpt-drag's SOURCE
 *               works (getSelection() over the pdf.js .textLayer).
 *
 * Structural note: this is a bare-`playwright` `.mjs` script (NOT a
 * `@playwright/test` spec — that package is not installed and there is no
 * playwright.config), matching this repo's existing smokes. Mirrors
 * scripts/capture-smoke.mjs: throwaway --user-data-dir profile, node:assert
 * assertions (a throw → non-zero exit), app.close() in finally.
 *
 * Run: pnpm smoke:pdf   (after `pnpm exec electron-vite build && pnpm rebuild:electron`)
 *      xvfb-run -a node scripts/pdf-render-smoke.mjs   (headless dev box / CI)
 *
 * @see docs/plans/v0.6-pdf-slim-slice.md §Task 15
 * @see docs/specs/v0.6-pdf-slim-slice.md §4 §7 §8
 * @see scripts/capture-smoke.mjs (reference launch + teardown pattern)
 */
import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '..', 'tests', 'fixtures', 'tiny.pdf')
// Scope every selector to the right dock: the app's center CanvasStage ALSO
// renders a <canvas>, so a bare `canvas` selector would match the wrong one and
// pass without pdf.js ever rendering. The PDF pane lives under [data-dock=right].
const RIGHT_DOCK = '[data-dock="right"]'

// Throwaway profile so the smoke never pollutes the real userData dir
// (matches capture-smoke.mjs / the v0.1.3 morph-harness pattern).
const userDataDir = mkdtempSync(join(tmpdir(), 'linsae-pdf-smoke-'))
const app = await electron.launch({
  args: ['out/main/index.js', `--user-data-dir=${userDataDir}`],
})

try {
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')

  // Loopback-origin gate (ADR 0008): pdf.js's same-origin worker AND the
  // fetch() of the PDF both require an http://127.0.0.1 document origin.
  const origin = await win.evaluate(() => location.origin)
  assert.ok(
    origin.startsWith('http://127.0.0.1'),
    `renderer must be served over loopback http (got ${origin})`,
  )
  console.log(`pdf-smoke [PASS] loopback origin (${origin})`)

  // Import the fixture + mark it open. Setting `pdf.openDocId` via raw IPC does
  // NOT invalidate the react-query ['setting','pdf.openDocId'] cache that
  // usePdfOpenId reads (src/renderer/src/lib/use-setting.ts), so the right dock
  // would not mount in this session — reload to re-fetch the setting on a fresh
  // mount (the thread-smoke seeds-then-reloads for exactly this reason).
  // window.api.pdf.import takes { filePath } (an object), NOT a positional path.
  const imported = await win.evaluate(async (filePath) => {
    const r = await window.api.pdf.import({ filePath })
    await window.api.settings.set({ key: 'pdf.openDocId', value: r.pdfId })
    return r
  }, FIXTURE)
  assert.ok(imported.pdfId, 'pdf.import returned a pdfId')
  assert.equal(
    imported.pageCount,
    1,
    `main-side pdf.js read the fixture as a 1-page PDF (got pageCount=${imported.pageCount})`,
  )
  console.log(
    `pdf-smoke: imported fixture pdfId=${imported.pdfId} pageCount=${imported.pageCount} title=${JSON.stringify(imported.title)}`,
  )

  await win.reload()
  await win.waitForLoadState('domcontentloaded')

  // The right dock + PDF pane mount once usePdfOpenId resolves non-null.
  await win.waitForSelector(RIGHT_DOCK, { timeout: 20000 })
  console.log('pdf-smoke: right dock mounted after reload')

  // Render-complete gate (NOT just canvas-sized): PdfReader sets canvas.width
  // SYNCHRONOUSLY, then `await renderTask.promise` PAINTS, then builds the text
  // layer (src/renderer/src/pdf/PdfReader.tsx:43-68). So a populated .textLayer
  // happens-AFTER the canvas is fully rasterized — without this gate the pixel
  // read below races the paint and sees a transparent, sized-but-empty canvas.
  await win.waitForFunction(
    (sel) => {
      const tl = document.querySelector(`${sel} .textLayer`)
      return !!tl && tl.childElementCount > 0
    },
    RIGHT_DOCK,
    { timeout: 25000 },
  )
  console.log('pdf-smoke: render complete (text layer populated → canvas painted)')

  // ── PRIMARY — worker boots under CSP + sandbox and paints the canvas ──────
  const canvasInfo = await win.evaluate((sel) => {
    const c = document.querySelector(`${sel} canvas`)
    const ctx = c.getContext('2d')
    const { data } = ctx.getImageData(0, 0, c.width, c.height)
    let painted = 0
    const colors = new Set()
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] !== 0) painted++ // any non-transparent pixel ⇒ pdf.js drew it
      // Arithmetic key (not bitwise) so an unrendered (all-transparent-black)
      // canvas vs a painted page are distinguishable by their color spread.
      colors.add(data[i] * 65536 + data[i + 1] * 256 + data[i + 2])
    }
    return { w: c.width, h: c.height, painted, distinctColors: colors.size }
  }, RIGHT_DOCK)
  assert.ok(
    canvasInfo.w > 0 && canvasInfo.h > 0,
    `pdf.js sized the canvas (got ${canvasInfo.w}×${canvasInfo.h})`,
  )
  assert.ok(
    canvasInfo.painted > 0,
    'pdf.js PAINTED the page (>=1 non-transparent pixel — an unrendered canvas is fully transparent)',
  )
  assert.ok(
    canvasInfo.distinctColors > 1,
    `pdf.js drew page CONTENT, not a blank fill (>1 distinct color — got ${canvasInfo.distinctColors})`,
  )
  console.log(
    `pdf-smoke [PASS] PRIMARY — worker booted + canvas painted ${canvasInfo.w}×${canvasInfo.h}, paintedPx=${canvasInfo.painted}, distinctColors=${canvasInfo.distinctColors}`,
  )

  // ── SECONDARY — loopback shell serves the PDF with application/pdf MIME ───
  const mediaUrl = await win.evaluate(async () => {
    const { value: pdfId } = await window.api.settings.get({ key: 'pdf.openDocId' })
    const open = await window.api.pdf.open({ pdfId })
    return open ? open.mediaUrl : null
  })
  assert.ok(mediaUrl, 'pdf.open returned a mediaUrl for the open PDF')
  const served = await win.evaluate(async (url) => {
    const r = await fetch(url)
    return { status: r.status, type: r.headers.get('content-type') }
  }, mediaUrl)
  assert.equal(served.status, 200, `loopback shell served the PDF (got HTTP ${served.status})`)
  assert.ok(
    (served.type ?? '').includes('application/pdf'),
    `served with application/pdf MIME (got ${served.type})`,
  )
  console.log(`pdf-smoke [PASS] SECONDARY — ${mediaUrl} → ${served.status} ${served.type}`)

  // ── TERTIARY — text layer spans are selectable, selection yields a quote ──
  // The .textLayer is already confirmed populated (render-complete gate above);
  // select all of it via a real DOM Range + getSelection and read the quote.
  const quote = await win.evaluate((sel) => {
    const tl = document.querySelector(`${sel} .textLayer`)
    const range = document.createRange()
    range.selectNodeContents(tl)
    const selection = window.getSelection()
    selection.removeAllRanges()
    selection.addRange(range)
    return selection.toString().trim()
  }, RIGHT_DOCK)
  assert.ok(
    quote.length > 0,
    `selecting the .textLayer yields a non-empty quote (got ${JSON.stringify(quote)})`,
  )
  console.log(
    `pdf-smoke [PASS] TERTIARY — selectable quote=${JSON.stringify(quote)} (${quote.length} chars)`,
  )

  console.log('\npdf-smoke: ALL ASSERTIONS PASSED')
} finally {
  await app.close()
  rmSync(userDataDir, { recursive: true, force: true })
}
