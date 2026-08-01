/**
 * Visual regression — the thread view for a plain note (v0.8.1 §4.4, #191).
 *
 * The generic (non-YouTube) branch of `ThreadView`: `ThreadRoot` on top, child
 * `NoteBubble`s under it, and the pinned `SimpleComposer`
 * (src/renderer/src/thread/ThreadView.tsx:906-971). Deliberately NOT the
 * YouTube branch — that one needs a live network and a consent wall
 * (scripts/thread-smoke.mjs:12-15), which is the opposite of deterministic.
 *
 * Two things here are not vault-seedable, and both are handled explicitly:
 *
 *  - A `comment-on` edge is DB-only. `replaceLinksForNote` writes only
 *    `edge_type='reference'` edges derived from the body and intentionally
 *    preserves `comment-on` across reconciles
 *    (src/main/db/queries/links.ts:37-48), so the reconciler cannot create one
 *    from a file. The children are therefore created through
 *    `notes.create({ commentOn })`, which routes to `setCommentOnEdge`
 *    (src/main/save-note.ts:231).
 *  - Because they are IPC-created, main stamps their `created_at` with
 *    `Date.now()`. Their wall-clock labels are consequently live, which is what
 *    `timeMasks` exists for. Their BODIES — everything the token guard actually
 *    cares about — are fixed.
 *
 * @see tests/visual/harness.ts (determinism contract)
 */
import { expect, test } from '@playwright/test'
import { assertBodyRendered, launchSeeded, THREAD_ROOT, timeMasks } from './harness'

/** Fixed child bodies. Order is pinned by `created_at`, see the sleep below. */
const CHILDREN = [
  'First reply. Child bubbles reuse the feed NoteBubble, so a token regression shows up here too.',
  'Second reply, with `inline code` and a **bold** run.',
]

test('thread view renders a plain-note thread', async () => {
  const seeded = await launchSeeded()
  try {
    const { page } = seeded

    await page.evaluate(
      async ({ root, children }) => {
        for (const body of children) {
          await window.api.notes.create({ body, type: 'claim', commentOn: root.slug })
          // `commentsForNote` orders by `created_at` with no tie-break
          // (src/main/db/queries/links.ts:122). A round-trip almost certainly
          // takes >1ms, but "almost certainly" is not a determinism guarantee —
          // this makes the two stamps provably distinct.
          await new Promise((r) => setTimeout(r, 25))
        }
        // Boot session-restore opens this thread on the next load
        // (src/renderer/src/App.tsx:873-895). Driving it through the persisted
        // session rather than a hover-revealed toolbar button keeps the pointer
        // off the feed, so no bubble is left in its hover state.
        await window.api.settings.set({
          key: 'ui.session.v1',
          value: { focusedNoteId: null, threadNoteId: root.id },
        })
      },
      { root: { id: THREAD_ROOT.id, slug: THREAD_ROOT.slug }, children: CHILDREN },
    )

    await page.reload()
    await page.waitForLoadState('domcontentloaded')

    await page.getByTestId('thread-generic-scroll').waitFor({ timeout: 30_000 })
    for (const body of CHILDREN) {
      await assertBodyRendered(page, body)
    }

    await expect(page).toHaveScreenshot('thread.png', { mask: timeMasks(page) })
  } finally {
    await seeded.dispose()
  }
})
