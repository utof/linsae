/**
 * Visual regression — the spatial canvas (v0.8.1 §4.4, #191).
 *
 * A different token surface from the feed: cards on the canvas ground rather
 * than bubbles on the feed band, plus the canvas chrome.
 *
 * Determinism note: the placement coordinates and the camera are written
 * through IPC BEFORE the view is opened, so nothing here depends on an
 * auto-layout pass or on where a drag happened to land. `canvas:setState` pins
 * the camera, which is otherwise restored from whatever the last session left
 * (src/renderer/src/canvas/useCanvasCamera.ts:70).
 *
 * @see tests/visual/harness.ts (determinism contract)
 * @see src/shared/canvas.ts (ROOT_CANVAS_ID / MANUAL_ARRANGEMENT_ID)
 */
import { expect, test } from '@playwright/test'
import { launchSeeded, SEED_NOTES, type SeedNote, timeMasks } from './harness'

/** Mirrors `ROOT_CANVAS_ID` / `MANUAL_ARRANGEMENT_ID` (src/shared/canvas.ts:10-11). */
const CANVAS_KEY = { canvasId: 'root', arrangementId: 'manual' }

/** Fixed world coordinates — a readable 3x2 grid, wide enough that cards never overlap. */
const PLACEMENTS = SEED_NOTES.map((n, i) => ({
  noteId: n.id,
  x: (i % 3) * 340,
  y: Math.floor(i / 3) * 260,
}))

test('canvas renders placed cards', async () => {
  const seeded = await launchSeeded()
  try {
    const { page } = seeded

    await page.evaluate(
      async ({ key, placements }) => {
        for (const p of placements) {
          await window.api.canvas.placeNote({ ...key, ...p })
        }
        // Camera chosen so the whole grid sits in frame at 1280x800 with margin.
        await window.api.canvas.setState({
          canvasId: key.canvasId,
          camera_x: -120,
          camera_y: -90,
          zoom: 1,
        })
      },
      { key: CANVAS_KEY, placements: PLACEMENTS },
    )

    // Reload so the canvas-state and layout queries re-fetch on a fresh mount
    // rather than serving the pre-seed cache (the seed-then-reload pattern the
    // `.mjs` smokes use — scripts/pdf-render-smoke.mjs:100).
    await page.reload()
    await page.waitForLoadState('domcontentloaded')

    await page.getByRole('button', { name: 'canvas view' }).click()

    // NoteCard stamps `data-note-id` (src/renderer/src/canvas/NoteCard.tsx:169).
    for (const n of SEED_NOTES as readonly SeedNote[]) {
      await expect(page.locator(`[data-note-id="${n.id}"]`)).toBeVisible({ timeout: 20_000 })
    }

    await expect(page).toHaveScreenshot('canvas.png', { mask: timeMasks(page) })
  } finally {
    await seeded.dispose()
  }
})
