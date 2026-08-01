/**
 * Visual regression — the rolling feed (v0.8.1 §4.4, #191).
 *
 * The app's default surface: day divider, note bubbles, the `?`-promoted
 * question note, the composer, and the window frame. Every foreground token
 * (`--fg-0` heading, `--fg-1` body, `--fg-2` metadata, `--fg-3` clock) is on
 * screen here, which is why this is the shot that most directly guards the
 * "AI writes black-on-black" failure mode
 * (`docs/specs/v0.1-rolling-feed-and-search.md:368`).
 *
 * @see tests/visual/harness.ts (determinism contract)
 */
import { expect, test } from '@playwright/test'
import { assertSeedRendered, launchSeeded, SEED_NOTES, timeMasks } from './harness'

test('feed renders the seeded vault', async () => {
  const seeded = await launchSeeded()
  try {
    const { page } = seeded
    // The feed anchors to the end on load, so the newest notes are the ones on
    // screen. Asserting BEFORE the shot is what stops a reconciler skip from
    // silently baselining an empty feed.
    await assertSeedRendered(page, SEED_NOTES.slice(-4))
    await expect(page).toHaveScreenshot('feed.png', { mask: timeMasks(page) })
  } finally {
    await seeded.dispose()
  }
})
