/**
 * Visual regression — the docked PDF reader (v0.8.1 §4.4, #191).
 *
 * Covers the surface with the most chrome per pixel: the right dock, the reader
 * toolbar, and the pdf.js page canvas + text layer side by side with the feed.
 *
 * The import/open/reload sequence and the render-complete gate are lifted from
 * `scripts/pdf-render-smoke.mjs` — that smoke already established that setting
 * `pdf.openDocId` through raw IPC does NOT invalidate the react-query cache
 * `usePdfOpenId` reads, so a reload is required before the dock mounts, and
 * that a populated `.textLayer` happens-AFTER the canvas is fully rasterised
 * (src/renderer/src/pdf/PdfReader.tsx:43-68). Without that gate the shot races
 * the paint and captures a sized-but-transparent canvas.
 *
 * @see tests/visual/harness.ts (determinism contract)
 * @see scripts/pdf-render-smoke.mjs
 */
import { expect, test } from '@playwright/test'
import { launchSeeded, TINY_PDF, timeMasks } from './harness'

/** The PDF pane lives in the right dock; the center canvas stage also renders a `<canvas>`. */
const RIGHT_DOCK = '[data-dock="right"]'

test('pdf reader renders a page', async () => {
  const seeded = await launchSeeded()
  try {
    const { page } = seeded

    const imported = await page.evaluate(async (filePath) => {
      const r = await window.api.pdf.import({ filePath })
      await window.api.settings.set({ key: 'pdf.openDocId', value: r.pdfId })
      return r
    }, TINY_PDF)
    expect(imported.pdfId, 'pdf.import returned a pdfId').toBeTruthy()

    await page.reload()
    await page.waitForLoadState('domcontentloaded')

    await page.locator(RIGHT_DOCK).waitFor({ timeout: 30_000 })
    // Render-complete gate: a populated text layer proves the page canvas was
    // already painted, so the screenshot cannot race pdf.js.
    await page.waitForFunction(
      (sel) => {
        const tl = document.querySelector(`${sel} .textLayer`)
        return !!tl && tl.childElementCount > 0
      },
      RIGHT_DOCK,
      { timeout: 30_000 },
    )

    await expect(page).toHaveScreenshot('pdf-reader.png', { mask: timeMasks(page) })
  } finally {
    await seeded.dispose()
  }
})
