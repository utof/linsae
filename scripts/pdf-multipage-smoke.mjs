/**
 * Playwright-Electron smoke for the v0.8 multipage PDF reader (Batch 4, Task 4.1).
 *
 * This script is the ONLY real verification of v0.8 success criteria 2, 3 and 4.
 * happy-dom does no layout, has no 2D context and no real Selection, so every
 * Vitest/RTL test on this branch pins *logic* against a mocked layout harness — none
 * of them can see a page paint, a canvas backing store, or a drag-selection resolving
 * to the page it was made on. This batch contributes no Vitest file by design (the
 * intended exception to CLAUDE.md §Tests every batch): *this batch is the test.*
 *
 * The gates, in the order the plan lists them:
 *   G1 continuous-scroll   — the scroller spans EVERY page, not one (criterion 1).
 *   G2 last-page raster    — page N's canvas holds real INK (criterion 2). Element
 *                            presence is not evidence of paint, and neither is
 *                            "opaque": a pdf.js page is painted white edge to edge, so
 *                            an opaque-pixel count is satisfied by a blank page. This
 *                            counts NON-WHITE opaque pixels over the whole surface —
 *                            stronger than sampling points, and immune to the failure
 *                            mode where a sample lands in a legitimately blank margin.
 *   G3 excerpt on page N   — a real DOM selection over page N's text layer produces a
 *                            note in SQLite whose `source_locator.page` is N (the
 *                            end-to-end proof Task 3.1 deferred to here), and — as a
 *                            SEPARATE gate, because they are separate claims — whose
 *                            rect is right in that page's user space (criterion 4).
 *   G4 zoom to ZOOM_MAX    — resident canvas bytes AND renderer working set stay under
 *                            stated §4.4 ceilings, and the reader keeps its page
 *                            (criterion 3).
 *   G5 500-page open       — open-to-first-paint has no stall and the list stays
 *                            windowed; G6 scrolling to page 500 completes and paints
 *                            (criterion 2 at book scale).
 *   G7 restore-to-page     — SKIPPED until Batch 5 lands the writer; see
 *                            RESTORE_GATE_LANDS_IN_BATCH_5 (Task 5.3 Step 3).
 *
 * Every gate is independently trapped and reported, then the run throws once at the
 * end listing all failures. A diagnostic smoke that dies on its first assertion hides
 * every gate after it, and "which of these broke" is the whole product here.
 *
 * WHY LAUNCH A FORCES devicePixelRatio 2 (`--force-device-scale-factor=2`):
 * spec §4.4's arithmetic ("one page at max zoom on a 900px dock at dpr 2 is
 * 9000 × 11646 × 4 B ≈ 419 MB") assumes a HiDPI display. This dev box reports dpr 1,
 * where a page at ZOOM_MAX in the 584px dock wants 2920 × 4129 = 12.06M px — UNDER
 * `MAX_PAGE_BITMAP_PX`, so `capBitmapPixels` is the identity and the criterion-3 cap
 * gate would pass without the cap ever engaging: a gate that can never fail. At dpr 2
 * the same page wants 48.2M px, the cap engages, and the backing store measures
 * 16.78M px ≈ 67 MB — spec §4.4's own number, reproduced. Launch B (500 pages) uses
 * the native dpr; it tests virtualization, not memory.
 *
 * Run: pnpm smoke:pdf-multipage
 *      (after `pnpm exec electron-vite build && pnpm rebuild:electron` — the launch
 *      loads `out/main/index.js`, and better-sqlite3 must be on Electron's ABI rather
 *      than Node's. `node scripts/ensure-electron-abi.mjs` is the probe-then-rebuild
 *      form and is what `pnpm dev` uses.)
 *      xvfb-run -a node scripts/pdf-multipage-smoke.mjs   (headless CI)
 *
 * @see docs/plans/v0.8-multipage-pdf.md §Task 4.1
 * @see docs/specs/v0.8-multipage-pdf.md §4.4 (memory budget), §4.5 (zoom), §4.7 (excerpt seam)
 * @see scripts/feed-scroll-restore-smoke.mjs (launch / two-launch profile template)
 * @see scripts/pdf-render-smoke.mjs (the v0.6 single-page reader gate this extends)
 * @issue utof/linsae#154
 */
import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'

const HERE = dirname(fileURLToPath(import.meta.url))
/** 3 pages, embedded TrueType subsets, a JPEG XObject and an inline SVG (#153). */
const FIXTURE_MULTI = join(HERE, '..', 'tests', 'fixtures', 'multi-feature.pdf')
const MULTI_PAGE_COUNT = 3

// ── Fixture facts, verified against the COMMITTED file ───────────────────────
// `getDocument(multi-feature.pdf).getPage(3)`: viewport(scale:1) is 595.30 × 841.89
// (A4), and every `getTextContent()` item on it has transform[4] == 56.80, the widest
// line ending at 56.80 + 444.46 = 501.26. G3 checks the captured rect against those;
// the fixture is committed and immutable, so this is a stronger claim than
// "non-degenerate" — which a rect spanning the entire page would also satisfy.
const PAGE3_USER_W = 595.3
const PAGE3_USER_H = 841.89
const PAGE3_TEXT_LEFT_PDF_X = 56.8
/** Slack for the CSS-px → user-space round trip across a ~0.98 scale factor. */
const RECT_TOLERANCE_PDF_UNITS = 2

// ── Memory budget (spec §4.4) ────────────────────────────────────────────────
/**
 * Mirrored from `src/renderer/src/pdf/capBitmapPixels.ts:18`, not imported: this is a
 * plain `.mjs` run by bare node and that module is TypeScript. A drift between the two
 * surfaces as a G4 failure, not as silence.
 */
const MAX_PAGE_BITMAP_PX = 16_777_216
/**
 * `capBitmapPixels` rounds, so the product can land a few thousand px above the cap —
 * its TSDoc measures the worst case at +3,444; this run observes +3,379.
 * @see src/renderer/src/pdf/capBitmapPixels.ts:43-48
 */
const BITMAP_PX_TOLERANCE = 4_096
const BYTES_PER_PX = 4
/**
 * Spec §4.4: "~1–2 resident × 67 MB ≈ 67–134 MB" at ZOOM_MAX, because
 * `overscan = zoom > 1 ? 0 : 1` drops all lookahead the moment the user zooms in.
 * 2 × 2^24 × 4 B = 134,217,728 B. Teeth: with the pixel cap removed one page is
 * 48.2M px ≈ 193 MB (fails); with overscan left at 1 a third page joins the window at
 * ~201 MB (fails).
 */
const MAX_RESIDENT_CANVAS_BYTES = 2 * MAX_PAGE_BITMAP_PX * BYTES_PER_PX
/**
 * `getAppMetrics()` reports memory in KILOBYTES — `MemoryInfo`: "All statistics are
 * reported in Kilobytes" (electronjs.org/docs/api/structures/memory-info).
 *
 * The LOAD-BEARING renderer gate is this DELTA, not the absolute below: a
 * baseline-relative ceiling is immune to the renderer's baseline drifting as the app
 * grows, and it is what actually separates a capped raster from an uncapped one.
 * Ceiling = §4.4's 134 MB of resident canvas + 26 MB slack for the window in which the
 * previous scale's bitmaps have not yet been released. Measured here: +52 MB.
 */
const ZOOM_WS_DELTA_CEILING_KB = 163_840
/**
 * Coarse absolute backstop — "nothing pathological", not a precision instrument.
 * ~206 MB measured renderer baseline + 134 MB (§4.4) + ~110 MB run-to-run slack.
 * Measured at ZOOM_MAX here: 256 MB.
 */
const RENDERER_WS_CEILING_KB = 460_800

// ── Zoom driver ──────────────────────────────────────────────────────────────
/** `clampZoom`'s ceiling — `src/renderer/src/pdf/computePdfRender.ts:54`. */
const ZOOM_MAX = 5
/** `ZOOM_STEP` in PdfReader's wheel handler is 1.1, and 1.1^20 = 6.7 ⇒ saturates. */
const ZOOM_NOTCHES = 20
/**
 * Notches go out ONE PER TASK, ~250ms apart, because that is what a wheel gesture
 * delivers. Dispatching them inside a single `evaluate` batches them into one React
 * commit, and the zoom re-anchor then mis-lands — `scrollToOffset` runs in the layout
 * effect BEFORE the grown spacer has been committed, so the browser clamps the new
 * offset to the old scroll range. Real gestures never reach that; driving this gate
 * synthetically would be testing the driver, not the reader.
 */
const ZOOM_NOTCH_INTERVAL_MS = 250

// ── 500-page document (criterion 2 at book scale) ────────────────────────────
const BIG_PAGE_COUNT = 500
/**
 * Measured here: ~630 ms from `pdf:import` to first ink (import 225 ms + reload and
 * paint 404 ms), and 67 ms to scroll to page 500 and paint it. The budgets are ~8×
 * and ~150× that — deliberately loose, because they exist to catch an
 * ORDER-OF-MAGNITUDE stall (an implementation that rasterized, or merely `getPage`d,
 * all 500 pages up front), not to police jitter on a loaded box.
 */
const FIRST_PAINT_BUDGET_MS = 5_000
const SCROLL_TO_END_BUDGET_MS = 10_000
/**
 * Two pages fit the viewport at fit-zoom, plus `overscan: 1` either side. A reader
 * that mounted the whole document would report 500 here — this is the real "no stall"
 * proof; the wall-clock budget above only corroborates it.
 */
const MAX_MOUNTED_PAGES = 6
/** Inter-page gutter — `PAGE_GAP_PX`, `src/renderer/src/pdf/PdfReader.tsx:37`. */
const PAGE_GAP_PX = 12

/**
 * G7 (quit → relaunch → restore to the same page) is written out below but not run:
 * the `pdf.view.v1` page / pageFraction writer does not exist until Batch 5 Task 5.1,
 * so today it would fail for a missing feature rather than a broken one.
 * **Task 5.3 Step 3 flips this to `false`.**
 */
const RESTORE_GATE_LANDS_IN_BATCH_5 = true

// ── Page-realm helpers ───────────────────────────────────────────────────────
// Each is passed whole to `evaluate` / `waitForFunction`, which serializes the
// function source across the process boundary — so none of them may reference
// anything from module scope, and none may call another helper. That is why the ink
// scan appears twice: `hasInkOnPage` short-circuits on the first hit (it is polled),
// while `inkCensusOnPage` has to walk the whole surface to count.

/**
 * Full ink census of one page's canvas. INK = opaque AND not near-white, which is what
 * separates "pdf.js drew this page" from "a canvas exists and was cleared to white".
 */
function inkCensusOnPage(pageNumber) {
  const canvas = document.querySelector(`[data-page-number="${pageNumber}"] canvas`)
  if (!canvas?.width) return null
  const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height)
  let opaque = 0
  let ink = 0
  const colors = new Set()
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] !== 0) opaque++
    if (data[i + 3] > 200 && (data[i] < 230 || data[i + 1] < 230 || data[i + 2] < 230)) ink++
    colors.add(data[i] * 65536 + data[i + 1] * 256 + data[i + 2])
  }
  return { w: canvas.width, h: canvas.height, opaque, ink, distinctColors: colors.size }
}

/** Polled predicate: has this page's canvas any non-white opaque pixel yet? */
function hasInkOnPage(pageNumber) {
  const sel =
    pageNumber === null ? '[data-page-number] canvas' : `[data-page-number="${pageNumber}"] canvas`
  const canvas = document.querySelector(sel)
  if (!canvas?.width) return false
  const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height)
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] > 200 && (data[i] < 230 || data[i + 1] < 230 || data[i + 2] < 230)) return true
  }
  return false
}

/** Which pages are mounted right now, and how big each backing store is. */
function canvasCensus() {
  const pages = Array.from(document.querySelectorAll('[data-page-number]'))
  return {
    mounted: pages.map((p) => Number(p.getAttribute('data-page-number'))),
    canvases: pages.flatMap((p) => {
      const c = p.querySelector('canvas')
      if (!c?.width) return []
      return [
        {
          page: Number(p.getAttribute('data-page-number')),
          px: c.width * c.height,
          cssW: Number.parseFloat(c.style.width),
        },
      ]
    }),
  }
}

/** Pages whose box currently intersects the scroller's viewport. */
function visiblePages(scroller) {
  const box = scroller.getBoundingClientRect()
  return Array.from(document.querySelectorAll('[data-page-number]'))
    .filter((p) => {
      const r = p.getBoundingClientRect()
      return r.bottom > box.top + 1 && r.top < box.bottom - 1
    })
    .map((p) => Number(p.getAttribute('data-page-number')))
}

/**
 * Build a `pageCount`-page PDF in memory. Written at runtime into the throwaway
 * profile dir and NEVER committed: a 500-page binary fixture is not reviewable, and no
 * PDF-generating dependency exists in this repo — adding one would breach CLAUDE.md's
 * "no new dep, no lockfile churn" hard gate.
 *
 * Each page carries a filled rectangle AND a text object. The rectangle is what the
 * ink assertions rely on: the text uses non-embedded Helvetica and `usePdfDocument`
 * passes only `{ data }` to `getDocument` (`usePdfDocument.ts:47`) — no
 * `standardFontDataUrl` — so standard-font glyph data is not guaranteed to be
 * available. A vector fill needs no font at all.
 *
 * xref byte offsets must be exact, so every chunk is measured as it is appended, and
 * `latin1` keeps one char == one byte.
 */
function buildPdfBytes(pageCount) {
  const chunks = []
  const offsets = []
  let length = 0
  const push = (s) => {
    const b = Buffer.from(s, 'latin1')
    chunks.push(b)
    length += b.length
  }
  const obj = (n, body) => {
    offsets[n] = length
    push(`${n} 0 obj\n${body}\nendobj\n`)
  }
  // Objects 1-3 are the catalog, the page tree and the shared font; page `i` then takes
  // 4+2i (the Page) and 5+2i (its content stream).
  const pageObjNum = (i) => 4 + 2 * i
  push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n')
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>')
  const kids = Array.from({ length: pageCount }, (_, i) => `${pageObjNum(i)} 0 R`).join(' ')
  obj(2, `<< /Type /Pages /Count ${pageCount} /Kids [${kids}] >>`)
  obj(3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  for (let i = 0; i < pageCount; i++) {
    const n = pageObjNum(i)
    obj(
      n,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
        `/Resources << /Font << /F1 3 0 R >> >> /Contents ${n + 1} 0 R >>`,
    )
    // The rectangle's y drifts with the page index so consecutive pages are not
    // pixel-identical: a reader that reused one raster for every page would still look
    // "painted", and this is what keeps that distinguishable.
    const stream =
      `0.10 0.35 0.85 rg\n72 ${120 + (i % 5) * 40} 468 420 re f\n` +
      `BT /F1 36 Tf 72 660 Td (linsae page ${i + 1} of ${pageCount}) Tj ET\n`
    obj(n + 1, `<< /Length ${stream.length} >>\nstream\n${stream}endstream`)
  }
  const total = 3 + 2 * pageCount + 1
  const xrefStart = length
  const rows = ['xref', `0 ${total}`, '0000000000 65535 f ']
  for (let n = 1; n < total; n++) rows.push(`${String(offsets[n]).padStart(10, '0')} 00000 n `)
  push(`${rows.join('\n')}\n`)
  push(`trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`)
  return Buffer.concat(chunks)
}

function launchApp(userDataDir, extraArgs = []) {
  return electron.launch({
    args: ['out/main/index.js', `--user-data-dir=${userDataDir}`, ...extraArgs],
  })
}

/**
 * The reader's OWN scroll container (`PdfReader.tsx:425-441`) — the nearest scrollable
 * ancestor of a rendered page. It carries no id, class or data attribute, and the
 * right dock wraps it in a `ScrollArea` of its own one level further out, so stopping
 * at the FIRST scrollable ancestor is what names the reader's scroller and not the
 * dock's.
 */
async function readerScroller(win) {
  const handle = await win.evaluateHandle(() => {
    let el = document.querySelector('[data-page-number]')
    while (el && el !== document.body) {
      const { overflowY } = getComputedStyle(el)
      if (overflowY === 'auto' || overflowY === 'scroll') return el
      el = el.parentElement
    }
    return null
  })
  assert.ok(
    await handle.evaluate((el) => el !== null),
    'no scrollable ancestor of [data-page-number] — the reader scroll container is gone',
  )
  return handle
}

/**
 * Import `filePath`, point `pdf.openDocId` at it, reload.
 *
 * The reload is load-bearing rather than cautious: setting the setting over raw IPC
 * does not invalidate the react-query `['setting','pdf.openDocId']` cache that
 * `usePdfOpenId` reads, so the right dock would never mount in this session. Same
 * seed-then-reload shape as `pdf-render-smoke.mjs:82-101`.
 */
async function openPdf(win, filePath) {
  const imported = await win.evaluate(async (path) => {
    const r = await window.api.pdf.import({ filePath: path })
    await window.api.settings.set({ key: 'pdf.openDocId', value: r.pdfId })
    return r
  }, filePath)
  await win.reload()
  await win.waitForLoadState('domcontentloaded')
  return imported
}

/**
 * Renderer working set, in KB, plus the GPU process's for context.
 *
 * `type: 'Renderer'` — which the plan named — does not exist. Chromium's
 * `GetProcessTypeNameInEnglish` calls a renderer process a **Tab**, and Electron's own
 * union is `'Browser' | 'Tab' | 'Utility' | 'Zygote' | 'Sandbox helper' | 'GPU' |
 * 'Pepper Plugin' | 'Pepper Plugin Broker' | 'Unknown'` (`electron.d.ts:11233`);
 * `'Renderer'` is not among them, so filtering on it would match nothing and the gate
 * would never run. It is kept as an accepted alias in case a future Electron renames.
 *
 * NOT `process.memoryUsage()` (the MAIN process heap — no canvas lives there, so it is
 * flat across zoom: a gate that can never fail) and NOT
 * `performance.measureUserAgentSpecificMemory()` (needs cross-origin isolation).
 *
 * The `kb > 0` assertion is deliberate: Electron populates `memory` per platform, so a
 * build that omitted it would otherwise leave this whole gate silently vacuous.
 */
async function rendererWorkingSetKb(app) {
  const metrics = await app.evaluate(({ app: electronApp }) => electronApp.getAppMetrics())
  const renderers = metrics.filter((m) => m.type === 'Tab' || m.type === 'Renderer')
  assert.ok(
    renderers.length > 0,
    `no renderer process in getAppMetrics(): ${JSON.stringify(metrics.map((m) => m.type))}`,
  )
  const kb = Math.max(...renderers.map((m) => m.memory?.workingSetSize ?? 0))
  assert.ok(
    kb > 0,
    'getAppMetrics() reported no renderer working set — the memory gate would be vacuous',
  )
  return { kb, gpuKb: metrics.find((m) => m.type === 'GPU')?.memory?.workingSetSize ?? 0 }
}

// ── Gate bookkeeping ─────────────────────────────────────────────────────────
const results = []
const detail = {}

/**
 * Run one gate, trapping its failure so the gates after it still run. The process
 * still exits non-zero — the summary below throws once, naming every failure.
 */
async function gate(name, fn) {
  try {
    const note = await fn()
    results.push({ name, status: 'PASS', note: note ?? '' })
    console.log(`pdf-multipage [PASS] ${name}${note ? ` — ${note}` : ''}`)
  } catch (err) {
    results.push({ name, status: 'FAIL', note: err?.message ?? String(err) })
    console.log(`pdf-multipage [FAIL] ${name} — ${err?.message ?? err}`)
  }
}

function skip(name, why) {
  results.push({ name, status: 'SKIP', note: why })
  console.log(`pdf-multipage [SKIP] ${name} — ${why}`)
}

const userDataDirA = mkdtempSync(join(tmpdir(), 'linsae-pdf-multipage-A-'))
const userDataDirB = mkdtempSync(join(tmpdir(), 'linsae-pdf-multipage-B-'))
const BIG_PDF = join(userDataDirB, `big-${BIG_PAGE_COUNT}.pdf`)

try {
  // ══ Launch A — multi-feature.pdf at dpr 2 (see the header) ═════════════════
  {
    const app = await launchApp(userDataDirA, ['--force-device-scale-factor=2'])
    try {
      const win = await app.firstWindow()
      win.on('pageerror', (e) => console.log(`  [renderer pageerror] ${e.message}`))
      await win.waitForLoadState('domcontentloaded')

      const imported = await openPdf(win, FIXTURE_MULTI)
      assert.equal(
        imported.pageCount,
        MULTI_PAGE_COUNT,
        `the fixture must be ${MULTI_PAGE_COUNT} pages (got ${imported.pageCount})`,
      )
      await win.waitForSelector('[data-page-number]', { timeout: 25_000 })
      const scroller = await readerScroller(win)
      detail.dpr = await win.evaluate(() => window.devicePixelRatio)
      console.log(`launch-A: ${imported.title} (${imported.pageCount}pp) open at dpr ${detail.dpr}`)

      // ── G1 — the scroller spans the WHOLE document (criterion 1) ───────────
      await gate('continuous-scroll', async () => {
        const geom = await scroller.evaluate((el) => ({
          scrollHeight: el.scrollHeight,
          clientHeight: el.clientHeight,
          clientWidth: el.clientWidth,
          pageH: document.querySelector('[data-page-number]').getBoundingClientRect().height,
        }))
        detail.fitGeom = geom
        // Exact rather than approximate: `estimateSize` IS the rendered cssH, and the
        // gutter is the virtualizer's `gap`, folded into `start` and never into `size`
        // (PdfReader.tsx:30-37). So the total is arithmetic — and a mismatch means the
        // list is measuring a different document from the one it is showing.
        const expected = MULTI_PAGE_COUNT * geom.pageH + (MULTI_PAGE_COUNT - 1) * PAGE_GAP_PX
        assert.ok(
          Math.abs(geom.scrollHeight - expected) <= 2,
          `scrollHeight ${geom.scrollHeight} != ${MULTI_PAGE_COUNT} × ${geom.pageH} + gaps (${expected}) — the scrollbar does not reflect the whole document`,
        )
        assert.ok(
          geom.scrollHeight > geom.clientHeight,
          `nothing to scroll (scrollHeight ${geom.scrollHeight} <= viewport ${geom.clientHeight})`,
        )
        return `scrollHeight ${geom.scrollHeight}px == ${MULTI_PAGE_COUNT} × ${Math.round(geom.pageH)}px + ${MULTI_PAGE_COUNT - 1} × ${PAGE_GAP_PX}px, viewport ${geom.clientHeight}px`
      })

      // ── G2 — the LAST page rasterizes real ink (criterion 2) ───────────────
      await scroller.evaluate((el) => {
        el.scrollTop = el.scrollHeight
      })
      // A populated text layer happens-AFTER `await renderTask.promise`
      // (PdfPage.tsx:134-154), so this is the render-complete gate: without it the
      // pixel read below races the paint and sees a sized-but-empty canvas.
      await win.waitForFunction(
        (page) => {
          const tl = document.querySelector(`[data-page-number="${page}"] .textLayer`)
          return !!tl && tl.childElementCount > 0
        },
        MULTI_PAGE_COUNT,
        { timeout: 25_000 },
      )
      await gate('last-page-raster', async () => {
        const census = await win.evaluate(inkCensusOnPage, MULTI_PAGE_COUNT)
        detail.lastPageCensus = census
        assert.ok(census, `page ${MULTI_PAGE_COUNT} has no sized canvas`)
        assert.ok(
          census.opaque > 0,
          `page ${MULTI_PAGE_COUNT}'s canvas is fully transparent — nothing painted`,
        )
        assert.ok(
          census.ink > 0,
          `page ${MULTI_PAGE_COUNT}'s canvas is blank white (${census.opaque} opaque px, 0 non-white) — painted, but with no content`,
        )
        assert.ok(
          census.distinctColors > 1,
          `page ${MULTI_PAGE_COUNT}'s canvas holds one flat colour (${census.distinctColors})`,
        )
        return `page ${MULTI_PAGE_COUNT} ${census.w}×${census.h}: ${census.ink} ink px, ${census.distinctColors} distinct colours`
      })

      // ── G3 — excerpt capture resolves to the LAST page (criterion 4) ───────
      await gate('excerpt-page-resolution', async () => {
        // A real drag: the Range starts and ends inside TEXT NODES of the page's own
        // spans, never on a container — that is the boundary shape `useExcerptCapture`
        // resolves through `range.startContainer` → `closest('[data-page-number]')`.
        // Spanning several spans is what a user produces, and what exercises the
        // multi-rect union in `clientRectsToPdfRect`.
        const selected = await win.evaluate((page) => {
          const host = document.querySelector(`[data-page-number="${page}"]`)
          const spans = Array.from(host.querySelectorAll('.textLayer span')).filter(
            (el) => el.firstChild?.nodeType === 3 && el.textContent.trim(),
          )
          const first = spans[0].firstChild
          const last = spans[Math.min(3, spans.length - 1)].firstChild
          const range = document.createRange()
          range.setStart(first, 0)
          range.setEnd(last, last.length)
          const sel = window.getSelection()
          sel.removeAllRanges()
          sel.addRange(range)
          return { text: sel.toString(), startIsTextNode: range.startContainer.nodeType === 3 }
        }, MULTI_PAGE_COUNT)
        assert.ok(selected.text.trim().length > 0, 'the selection is empty — nothing to excerpt')
        assert.ok(selected.startIsTextNode, 'expected a text-node Range boundary (a real drag)')
        detail.selection = selected.text

        // mouseup on the SCROLL CONTAINER, which is where the listener actually lives
        // (`PdfReader.tsx:409` → `useExcerptCapture` binds to `scrollEl`).
        await scroller.evaluate((el) =>
          el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true })),
        )
        // The sticky "Excerpt →" bar renders only once `pending` is set, so waiting for
        // it is waiting for the capture to have completed.
        const affordance = win.locator('button', { hasText: 'Excerpt' })
        await affordance.waitFor({ timeout: 15_000 })
        await affordance.click()

        // Read the locator back out of SQLite rather than out of the zustand store: the
        // note is the artifact criterion 4 is about, and this proves the whole chain
        // (selection → capture → excerpt bridge → notes:create → DB) end to end.
        const handle = await win.waitForFunction(
          async () => {
            const notes = await window.api.notes.list({ limit: 500 })
            return (
              notes.find((n) => n.source_locator?.media === 'pdf' && n.source_locator.page) ?? null
            )
          },
          undefined,
          { timeout: 20_000, polling: 300 },
        )
        const note = await handle.jsonValue()
        detail.locator = note.source_locator

        assert.equal(
          note.source_locator.page,
          MULTI_PAGE_COUNT,
          `the excerpt resolved to page ${note.source_locator.page}, not the page the selection was made on (${MULTI_PAGE_COUNT})`,
        )
        assert.equal(
          note.source_locator.quote,
          selected.text,
          'the persisted quote is not the text that was selected',
        )
        const [w, h] = note.source_locator.rect.slice(2)
        assert.ok(
          w > 0 && h > 0,
          `the rect is degenerate: ${JSON.stringify(note.source_locator.rect)}`,
        )
        return `page ${note.source_locator.page}, rect [${note.source_locator.rect.map((n) => n.toFixed(1)).join(', ')}], quote ${JSON.stringify(selected.text.slice(0, 40))}…`
      })

      // ── G3b — and the rect is CORRECT, not merely plausible (criterion 4) ──
      // Split from G3 on purpose. "The excerpt landed on the page the drag was made
      // on" (Task 3.1's deliverable) and "its geometry is right in that page's user
      // space" are different claims with different owners, and collapsing them would
      // let a failure in one hide the other's result — which is the whole reason this
      // script reports per-gate.
      await gate('excerpt-rect-geometry', async () => {
        assert.ok(detail.locator, 'no locator captured (see excerpt-page-resolution)')
        const [x, y, w, h] = detail.locator.rect
        assert.ok(
          x >= 0 && y >= 0 && x + w <= PAGE3_USER_W + 1 && y + h <= PAGE3_USER_H + 1,
          `the rect ${JSON.stringify(detail.locator.rect)} falls outside page ${MULTI_PAGE_COUNT}'s user space (${PAGE3_USER_W} × ${PAGE3_USER_H})`,
        )
        assert.ok(
          Math.abs(x - PAGE3_TEXT_LEFT_PDF_X) <= RECT_TOLERANCE_PDF_UNITS,
          `the rect's left edge is ${x}, expected ~${PAGE3_TEXT_LEFT_PDF_X} — every text item on page ${MULTI_PAGE_COUNT} starts at that x, so a rect reaching further left has unioned in boxes that are not glyphs`,
        )
        return `left edge ${x} ≈ ${PAGE3_TEXT_LEFT_PDF_X}, and the box sits inside ${PAGE3_USER_W} × ${PAGE3_USER_H}`
      })

      // ── G4 — ZOOM_MAX: bounded canvas + bounded renderer (criterion 3) ─────
      const before = await rendererWorkingSetKb(app)
      const beforeCensus = await win.evaluate(canvasCensus)
      const beforeVisible = await scroller.evaluate(visiblePages)
      detail.zoom1 = { ...before, census: beforeCensus, visible: beforeVisible }
      console.log(
        `launch-A: fit — renderer ${before.kb} KB, GPU ${before.gpuKb} KB, canvases ${JSON.stringify(beforeCensus.canvases.map((c) => c.px))}, visible ${JSON.stringify(beforeVisible)}`,
      )

      for (let i = 0; i < ZOOM_NOTCHES; i++) {
        await scroller.evaluate((el) =>
          el.dispatchEvent(
            new WheelEvent('wheel', {
              deltaY: -100,
              ctrlKey: true,
              bubbles: true,
              cancelable: true,
            }),
          ),
        )
        await new Promise((r) => setTimeout(r, ZOOM_NOTCH_INTERVAL_MS))
      }
      // Let the final scale's raster finish and the previous scale's bitmaps be released
      // before sampling: measuring mid-transition reads both generations at once.
      await new Promise((r) => setTimeout(r, 4_000))

      const after = await rendererWorkingSetKb(app)
      const afterCensus = await win.evaluate(canvasCensus)
      const afterVisible = await scroller.evaluate(visiblePages)
      detail.zoomMax = { ...after, census: afterCensus, visible: afterVisible }
      console.log(
        `launch-A: ZOOM_MAX — renderer ${after.kb} KB, GPU ${after.gpuKb} KB, canvases ${JSON.stringify(afterCensus.canvases.map((c) => c.px))}, visible ${JSON.stringify(afterVisible)}`,
      )

      await gate('zoom-reached-max', async () => {
        // The CSS box is `fitCssW × zoom` (computePdfRender), so at ZOOM_MAX the
        // rendered CSS width is exactly ZOOM_MAX × the fit width. Without this check
        // every ceiling below could be satisfied simply by not having zoomed.
        const fitCssW = beforeCensus.canvases[0].cssW
        const maxCssW = afterCensus.canvases[0].cssW
        assert.ok(
          Math.abs(maxCssW - fitCssW * ZOOM_MAX) <= ZOOM_MAX,
          `zoom did not saturate at ZOOM_MAX: CSS width ${maxCssW}px vs the expected ${fitCssW * ZOOM_MAX}px`,
        )
        return `CSS page width ${fitCssW}px → ${maxCssW}px (${ZOOM_MAX}×)`
      })

      await gate('zoom-max-canvas-bounded', async () => {
        for (const c of afterCensus.canvases) {
          assert.ok(
            c.px <= MAX_PAGE_BITMAP_PX + BITMAP_PX_TOLERANCE,
            `page ${c.page}'s backing store is ${c.px} px, over MAX_PAGE_BITMAP_PX ${MAX_PAGE_BITMAP_PX} — capBitmapPixels did not engage`,
          )
        }
        const bytes = afterCensus.canvases.reduce((sum, c) => sum + c.px * BYTES_PER_PX, 0)
        assert.ok(
          bytes <= MAX_RESIDENT_CANVAS_BYTES,
          `resident canvas is ${(bytes / 1e6).toFixed(1)} MB across ${afterCensus.canvases.length} page(s), over §4.4's ${(MAX_RESIDENT_CANVAS_BYTES / 1e6).toFixed(1)} MB`,
        )
        const largest = Math.max(...afterCensus.canvases.map((c) => c.px))
        const engaged = largest > MAX_PAGE_BITMAP_PX * 0.99
        return `${afterCensus.canvases.length} resident canvas(es), ${(bytes / 1e6).toFixed(1)} MB total, largest ${largest} px — cap ${engaged ? 'ENGAGED' : 'NOT reached'}`
      })

      await gate('zoom-max-renderer-memory', async () => {
        const delta = after.kb - before.kb
        assert.ok(
          delta <= ZOOM_WS_DELTA_CEILING_KB,
          `the renderer working set grew ${(delta / 1024).toFixed(1)} MB from fit to ZOOM_MAX, over the ${(ZOOM_WS_DELTA_CEILING_KB / 1024).toFixed(0)} MB §4.4 ceiling`,
        )
        assert.ok(
          after.kb <= RENDERER_WS_CEILING_KB,
          `the renderer working set is ${(after.kb / 1024).toFixed(1)} MB at ZOOM_MAX, over the ${(RENDERER_WS_CEILING_KB / 1024).toFixed(0)} MB backstop`,
        )
        return `${(before.kb / 1024).toFixed(1)} → ${(after.kb / 1024).toFixed(1)} MB (Δ ${(delta / 1024).toFixed(1)} MB, ceiling ${(ZOOM_WS_DELTA_CEILING_KB / 1024).toFixed(0)} MB); GPU ${(before.gpuKb / 1024).toFixed(1)} → ${(after.gpuKb / 1024).toFixed(1)} MB`
      })

      await gate('zoom-holds-position', async () => {
        // Spec §4.5's whole reason for the re-anchor: zooming must not throw the reader
        // off the page it was reading. Without this the memory numbers above could have
        // been measured on a page the user never asked for.
        assert.ok(
          afterVisible.some((p) => beforeVisible.includes(p)),
          `zoom moved the reader off its page: ${JSON.stringify(beforeVisible)} at fit → ${JSON.stringify(afterVisible)} at ZOOM_MAX`,
        )
        return `page(s) ${JSON.stringify(beforeVisible)} at fit → ${JSON.stringify(afterVisible)} at ZOOM_MAX`
      })
    } finally {
      await app.close()
    }
  }

  // ══ Launch B — a 500-page document at the native dpr ═══════════════════════
  {
    writeFileSync(BIG_PDF, buildPdfBytes(BIG_PAGE_COUNT))
    const app = await launchApp(userDataDirB)
    try {
      const win = await app.firstWindow()
      win.on('pageerror', (e) => console.log(`  [renderer pageerror] ${e.message}`))
      await win.waitForLoadState('domcontentloaded')

      const t0 = Date.now()
      const imported = await openPdf(win, BIG_PDF)
      assert.equal(
        imported.pageCount,
        BIG_PAGE_COUNT,
        `the generated PDF must be ${BIG_PAGE_COUNT} pages`,
      )
      // First INK, not first element: a mounted <canvas> with nothing on it is exactly
      // what a stalled first paint looks like.
      await win.waitForFunction(hasInkOnPage, null, { timeout: 60_000 })
      const firstPaintMs = Date.now() - t0
      detail.bigFirstPaintMs = firstPaintMs
      const scroller = await readerScroller(win)

      await gate('500-page-open-no-stall', async () => {
        const geom = await scroller.evaluate((el) => ({
          scrollHeight: el.scrollHeight,
          pageH: document.querySelector('[data-page-number]').getBoundingClientRect().height,
          mounted: document.querySelectorAll('[data-page-number]').length,
        }))
        detail.bigGeom = geom
        assert.ok(
          firstPaintMs <= FIRST_PAINT_BUDGET_MS,
          `open-to-first-paint took ${firstPaintMs}ms for ${BIG_PAGE_COUNT} pages, over the ${FIRST_PAINT_BUDGET_MS}ms budget`,
        )
        assert.ok(
          geom.mounted <= MAX_MOUNTED_PAGES,
          `${geom.mounted} pages are mounted at once — the list is not windowed`,
        )
        const expected = BIG_PAGE_COUNT * geom.pageH + (BIG_PAGE_COUNT - 1) * PAGE_GAP_PX
        assert.ok(
          Math.abs(geom.scrollHeight - expected) <= 2,
          `scrollHeight ${geom.scrollHeight} != ${BIG_PAGE_COUNT} pages (${expected})`,
        )
        return `first paint ${firstPaintMs}ms, ${geom.mounted} pages mounted, scrollHeight ${geom.scrollHeight}px == ${BIG_PAGE_COUNT} pages`
      })

      await gate('500-page-scroll-to-last', async () => {
        const t1 = Date.now()
        await scroller.evaluate((el) => {
          el.scrollTop = el.scrollHeight
        })
        await win.waitForSelector(`[data-page-number="${BIG_PAGE_COUNT}"]`, {
          timeout: SCROLL_TO_END_BUDGET_MS,
        })
        await win.waitForFunction(hasInkOnPage, BIG_PAGE_COUNT, {
          timeout: SCROLL_TO_END_BUDGET_MS,
        })
        const ms = Date.now() - t1
        const text = await win.evaluate(
          (page) =>
            document.querySelector(`[data-page-number="${page}"] .textLayer`)?.textContent ?? '',
          BIG_PAGE_COUNT,
        )
        // Every generated page states its own number, so this proves the reader landed
        // on page 500's CONTENT — not merely on an element labelled 500.
        assert.ok(
          text.includes(`page ${BIG_PAGE_COUNT} of ${BIG_PAGE_COUNT}`),
          `page ${BIG_PAGE_COUNT}'s text layer reads ${JSON.stringify(text)} — that is not page ${BIG_PAGE_COUNT}'s content`,
        )
        return `page ${BIG_PAGE_COUNT} mounted, painted and text-verified in ${ms}ms`
      })
    } finally {
      await app.close()
    }

    // ── G7 — quit + relaunch restores the same page (Batch 5) ────────────────
    if (RESTORE_GATE_LANDS_IN_BATCH_5) {
      skip(
        'restore-to-page-after-restart',
        'the pdf.view.v1 page/pageFraction writer lands in Batch 5 (Task 5.1); Task 5.3 Step 3 flips RESTORE_GATE_LANDS_IN_BATCH_5 to false',
      )
    } else {
      const app = await launchApp(userDataDirB)
      try {
        const win = await app.firstWindow()
        await win.waitForLoadState('domcontentloaded')
        // No import and no reload: the document AND the persisted position both come
        // from profile B, exactly as on a real restart.
        await win.waitForSelector('[data-page-number]', { timeout: 25_000 })
        const scroller = await readerScroller(win)
        await gate('restore-to-page-after-restart', async () => {
          const visible = await scroller.evaluate(visiblePages)
          assert.ok(
            visible.some((p) => Math.abs(p - BIG_PAGE_COUNT) <= 1),
            `restored to page(s) ${JSON.stringify(visible)}, expected ~${BIG_PAGE_COUNT}`,
          )
          return `restored to page(s) ${JSON.stringify(visible)}`
        })
      } finally {
        await app.close()
      }
    }
  }

  // ══ Summary ════════════════════════════════════════════════════════════════
  console.log('\npdf-multipage RESULTS:')
  for (const r of results) {
    console.log(`  ${r.status.padEnd(4)} ${r.name}${r.note ? ` — ${r.note}` : ''}`)
  }
  console.log('\nMEASUREMENTS (what the ceilings above were derived against):')
  console.log(`  devicePixelRatio (launch A) : ${detail.dpr}`)
  console.log(
    `  reader viewport             : ${detail.fitGeom?.clientWidth}×${detail.fitGeom?.clientHeight} CSS px`,
  )
  console.log(
    `  renderer WS @ fit           : ${detail.zoom1?.kb} KB (${(detail.zoom1?.kb / 1024).toFixed(1)} MB)`,
  )
  console.log(
    `  renderer WS @ ZOOM_MAX      : ${detail.zoomMax?.kb} KB (${(detail.zoomMax?.kb / 1024).toFixed(1)} MB)`,
  )
  console.log(`  resident canvas @ ZOOM_MAX  : ${JSON.stringify(detail.zoomMax?.census.canvases)}`)
  console.log(`  500-page first paint        : ${detail.bigFirstPaintMs}ms`)
  console.log(`  captured locator            : ${JSON.stringify(detail.locator)}`)

  const failed = results.filter((r) => r.status === 'FAIL')
  if (failed.length > 0) {
    throw new Error(
      `pdf-multipage: ${failed.length} gate(s) FAILED — ${failed.map((r) => r.name).join(', ')}`,
    )
  }
  console.log('\npdf-multipage: ALL GATES PASSED')
} finally {
  rmSync(userDataDirA, { recursive: true, force: true })
  rmSync(userDataDirB, { recursive: true, force: true })
}
