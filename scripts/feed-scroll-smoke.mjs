/**
 * Playwright-Electron smoke for the feed's real-layout scroll behavior on
 * react-virtual 3.14.5 / virtual-core 3.17.3 (Task 0.1, ADR 0054). happy-dom
 * does no layout, so unit tests can't catch a scroll-anchoring regression; this
 * drives a real Chromium layout instead.
 *
 * IMPORTANT — this is an APP-BEHAVIOR gate, NOT a virtual-core version gate.
 * Feed supplies a CUSTOM `shouldAdjustScrollPositionOnItemSizeChange`
 * (src/renderer/src/feed/Feed.tsx:622-623, always-true when idle), and
 * virtual-core's #1199/#1212 fixes live only in the DEFAULT predicate branch
 * (dist/esm/index.js:849 ternary → :869), so those fixes are never exercised by
 * the Feed and cannot be gated here. What this smoke DOES gate is the actual
 * Feed scroll-anchoring behavior that Batch 3's feed-scroll-restore builds on,
 * plus #1209's predicate-independent end-anchor clamp (index.js:847/876-877). See
 * ADR 0054 for the full trace.
 *
 * Three checks:
 *
 *   1. anchored-to-end        — baseline: a freshly-loaded, overflowing feed
 *                              sits pinned to the bottom (anchorTo:'end'). This
 *                              is the predicate-independent end-anchor path that
 *                              virtual-core#1209 hardened.
 *   2. backward-jump-stable   — jump from the bottom into never-measured rows in
 *                              one step; after settle the feed must reach a
 *                              STABLE, VALID anchor (a top-visible note pinned to
 *                              the top edge) and must NOT keep drifting. It
 *                              tolerates the one legitimate estimate→measured
 *                              content shift the fixed lib shows on the single
 *                              measurement frame (verified: the top note moves
 *                              ~2 rows on that frame, then is rock-stable); the
 *                              failure modes it catches are runaway drift,
 *                              blanking, and oscillation.
 *   3. dock-toggle-no-drift   — opening the right dock changes the feed's band
 *                              width in one render (no CSS/JS width tween —
 *                              confirmed by reading Dock.tsx/DockHost.tsx/
 *                              globals.css); the same top-visible note must stay
 *                              put. A general behavioral guard.
 *
 * Note (assertion 2 scope): a LITERAL data-prepend smoke (older notes loaded
 * above already-rendered ones) isn't possible today — there is no scroll-back
 * pagination in the app yet (`notes.list`'s `before` cursor is wired end-to-end
 * but nothing calls it — src/renderer/src/App.tsx:100-108's comment cites
 * issue #20) and `notes:create`'s `created_at` is always `Date.now()`
 * server-side (src/main/save-note.ts:104), so a new note can never land above
 * existing ones. See ADR 0054 Consequences for the deferred literal-prepend
 * follow-up (issue #20) and the Batch-3 restore round-trip.
 *
 * Run: pnpm rebuild:electron && pnpm smoke:feed
 *
 * @see scripts/thread-smoke.mjs (the `_electron` launch/seed/teardown template)
 * @see adrs/0054-virtual-core-3.17-bump.md
 * @see src/renderer/src/feed/Feed.tsx (scroller + virtualizer options + the
 *      custom predicate at :622 that makes this an app-behavior gate)
 */
import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron } from 'playwright'

// Comfortably overflows the 800px-tall default window (~60px/row) so most
// rows are never rendered/measured until scrolled into view.
const SEED_COUNT = 120

// Sub-pixel layout rounding plus a possible scrollbar gutter make exact-pixel
// equality flaky; 4px is well below one row (~60px), so a real anchor jump
// (tens of px) still trips it while sub-pixel noise doesn't.
const DRIFT_TOLERANCE_PX = 4

// Throwaway profile so the smoke never pollutes the real userData dir.
const userDataDir = mkdtempSync(join(tmpdir(), 'linsae-feed-scroll-smoke-'))

const app = await electron.launch({
  args: ['out/main/index.js', `--user-data-dir=${userDataDir}`],
})

const results = {
  anchoredToEnd: 'FAIL',
  backwardJumpStable: 'FAIL',
  dockToggleNoDrift: 'FAIL',
}

/**
 * The Feed's scroller: the only `.scroll-area-inner` element with a
 * virtualized `[data-index]` row descendant. `.scroll-area-inner` is shared
 * with ThreadView's own scroller (src/renderer/src/thread/ThreadView.tsx:217),
 * but only Feed renders `data-index` rows (src/renderer/src/feed/Feed.tsx:887),
 * so filtering on that descendant disambiguates even while a dock pane with
 * its own ScrollArea is mounted alongside it.
 */
function feedScroller(win) {
  return win.locator('.scroll-area-inner').filter({ has: win.locator('[data-index]') })
}

/**
 * Reads the top-visible note's identity plus its geometry. There is no note-id
 * DOM attribute anywhere in Feed.tsx/NoteBubble.tsx (grep-confirmed) — `vItem.key`
 * (the note id) is only a React key, never rendered to the DOM — so the seeded
 * body text read off the real `[data-bubble-body]` element (unique per seed note
 * by construction) stands in for it. Returns `scrollTop`, the anchor row's
 * `index`/`text`, its `offset` = `getBoundingClientRect().top − scroller.top`
 * (pixel distance from the scroller's top edge), and its `height`. The offset is
 * the anchoring invariant: whether the row the user is looking at stays put.
 */
async function topVisible(scroller) {
  return scroller.evaluate((el) => {
    const scrollerTop = el.getBoundingClientRect().top
    const rows = Array.from(el.querySelectorAll('[data-index]'))
    const top = rows.find((row) => row.getBoundingClientRect().bottom - scrollerTop > 1)
    const rect = top?.getBoundingClientRect()
    const body = top?.querySelector('[data-bubble-body]')
    return {
      scrollTop: el.scrollTop,
      index: top?.getAttribute('data-index') ?? null,
      text: body?.textContent ?? null,
      offset: rect ? rect.top - scrollerTop : null,
      height: rect ? rect.height : null,
    }
  })
}

/**
 * Polls `readFn()` every `intervalMs` until `done(latest, previous)` is true or
 * `deadlineMs` elapses, then returns the last read (`previous` is `null` on the
 * first check). Mirrors thread-smoke.mjs's poll-until-condition-or-deadline loop
 * (scripts/thread-smoke.mjs:106-136) — replaces arbitrary fixed settle sleeps,
 * which false-fail a slow/cold layout sizer and false-pass a fast one.
 */
async function poll(readFn, { done, deadlineMs, intervalMs = 100 }) {
  const start = Date.now()
  let previous = null
  let latest = await readFn()
  while (!done(latest, previous) && Date.now() - start < deadlineMs) {
    await new Promise((r) => setTimeout(r, intervalMs))
    previous = latest
    latest = await readFn()
  }
  return latest
}

// A settle is reached when `scrollTop` stops moving between two consecutive
// polls — the virtualizer has finished any first-measurement / resize
// compensation. (Waiting on scrollTop is note-independent, so it can't be
// thrown off by the top-visible row flipping mid-settle.)
const scrollTopSettled = (a, b) =>
  b !== null && Math.abs(a.scrollTop - b.scrollTop) <= DRIFT_TOLERANCE_PX

try {
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')

  // ── Seed enough notes to badly overflow the viewport ───────────────────────
  // One evaluate call driving the loop in-page avoids SEED_COUNT round-trips.
  console.log(`feed-scroll-smoke: seeding ${SEED_COUNT} notes …`)
  await win.evaluate(async (count) => {
    for (let i = 0; i < count; i++) {
      await window.api.notes.create({ body: `seed note ${String(i).padStart(4, '0')}` })
    }
  }, SEED_COUNT)

  // Reload so the feed's initial `useLayoutEffect` scrollToEnd() runs against
  // the full seeded set (mirrors thread-smoke.mjs's seed-then-reload pattern).
  await win.reload()
  await win.waitForLoadState('domcontentloaded')

  const scroller = feedScroller(win)
  await scroller.waitFor({ timeout: 15000 })
  await win.locator('[data-index]').first().waitFor({ timeout: 15000 })

  // ── 1. anchored to end ──────────────────────────────────────────────────────
  // Poll (≤2s) for the initial scrollToEnd() + last-row measurements to land
  // within tolerance, rather than a fixed sleep a cold sizer could outlast.
  const gap = await poll(
    () => scroller.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight),
    { done: (g) => g <= DRIFT_TOLERANCE_PX, deadlineMs: 2000 },
  )
  console.log(`feed-scroll-smoke: initial gap-from-end = ${gap}px`)
  if (gap > DRIFT_TOLERANCE_PX) throw new Error(`not anchored to end: gap=${gap}`)
  results.anchoredToEnd = 'PASS'
  console.log('feed-scroll-smoke [PASS] anchored to end')

  // ── 2. backward jump into never-measured rows settles to a stable anchor ─────
  // Jump from the bottom straight to ~15% down from the top in ONE step: only
  // the last `overscan` window near the bottom has ever been rendered, so nearly
  // everything above fires its first measurement at once. Settle, then require a
  // stable, valid anchor. We deliberately do NOT compare a first-frame snapshot
  // to the settled one: the fixed lib legitimately resolves estimate→measured
  // heights on the single measurement frame (the top note shifts ~2 rows, then
  // is rock-stable), so an immediate-vs-settled check would false-fail. The real
  // failure modes we gate are a blank/overshot feed and continued drift.
  await scroller.evaluate((el) => {
    el.scrollTop = Math.round(el.scrollHeight * 0.15)
  })
  const anchor = await poll(() => topVisible(scroller), {
    done: scrollTopSettled,
    deadlineMs: 2000,
  })
  console.log(`feed-scroll-smoke: backward-jump settled anchor = ${JSON.stringify(anchor)}`)
  assert.ok(anchor.text, 'expected a stable top-visible note after the backward jump')
  // The anchor row must straddle the scroller's top edge — its top within one
  // row-height above, and no more than a tolerance below (no gap). Catches a
  // blank feed / overshoot-above (no row, or empty space above the first row).
  if (anchor.offset > DRIFT_TOLERANCE_PX || anchor.offset < -(anchor.height + DRIFT_TOLERANCE_PX)) {
    throw new Error(
      `anchor not pinned to the top edge after backward jump: ${JSON.stringify(anchor)}`,
    )
  }
  // …and it must not keep drifting (runaway / oscillation). Confirm it stays put
  // across a further window. This is a "stays-put" confirmation, not a settle
  // wait, so a short window can only under-confirm — it can't false-fail.
  //
  // Known flake tail (not seen in practice; compensation normally fires <100ms so
  // the `poll` settle above already lands post-compensation): on a heavily-loaded
  // box, if first-measurement compensation is delayed past ~200ms, `scrollTopSettled`
  // could settle on two pre-compensation reads, and this +400ms recheck would then
  // observe the LEGITIMATE compensation land and misreport it as drift. Fix if seen:
  // re-settle (poll until scrollTopSettled) right before the recheck instead of a
  // fixed 400ms. Batch 3 extends this smoke with the restore round-trip and can
  // harden it then.
  await new Promise((r) => setTimeout(r, 400))
  const recheck = await topVisible(scroller)
  console.log(`feed-scroll-smoke: backward-jump recheck = ${JSON.stringify(recheck)}`)
  if (
    recheck.text !== anchor.text ||
    Math.abs(recheck.offset - anchor.offset) > DRIFT_TOLERANCE_PX ||
    Math.abs(recheck.scrollTop - anchor.scrollTop) > DRIFT_TOLERANCE_PX
  ) {
    throw new Error(
      `feed kept drifting after settling: settled=${JSON.stringify(anchor)} recheck=${JSON.stringify(recheck)}`,
    )
  }
  results.backwardJumpStable = 'PASS'
  console.log('feed-scroll-smoke [PASS] backward jump settles to a stable anchor')

  // ── 3. dock width change does not drift the feed ────────────────────────────
  await scroller.evaluate((el) => {
    el.scrollTop = Math.round(el.scrollHeight * 0.4)
  })
  const beforeToggle = await poll(() => topVisible(scroller), {
    done: scrollTopSettled,
    deadlineMs: 2000,
  })
  console.log(`feed-scroll-smoke: mid-list before dock toggle = ${JSON.stringify(beforeToggle)}`)
  assert.ok(beforeToggle.text, 'expected a top-visible note before the dock toggle')

  const toggleBtn = win.getByRole('button', { name: 'toggle backlinks' })
  await toggleBtn.waitFor({ timeout: 5000 })
  await toggleBtn.click()
  const afterToggle = await poll(() => topVisible(scroller), {
    done: scrollTopSettled,
    deadlineMs: 2000,
  })
  console.log(`feed-scroll-smoke: mid-list after dock toggle = ${JSON.stringify(afterToggle)}`)

  if (
    afterToggle.text !== beforeToggle.text ||
    Math.abs(afterToggle.offset - beforeToggle.offset) > DRIFT_TOLERANCE_PX
  ) {
    throw new Error(
      `dock toggle drifted the feed: before=${JSON.stringify(beforeToggle)} after=${JSON.stringify(afterToggle)}`,
    )
  }
  results.dockToggleNoDrift = 'PASS'
  console.log('feed-scroll-smoke [PASS] dock width change does not drift the feed')

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log('')
  console.log('feed-scroll-smoke RESULTS:')
  console.log(`  anchored to end:        ${results.anchoredToEnd}`)
  console.log(`  backward-jump stable:   ${results.backwardJumpStable}`)
  console.log(`  dock toggle no drift:   ${results.dockToggleNoDrift}`)
  console.log('')
} finally {
  await app.close()
  rmSync(userDataDir, { recursive: true, force: true })
}
