/**
 * Playwright-Electron RESTORE round-trip smoke for v0.7 feed-scroll persistence
 * (Batch 3, ADR 0054). happy-dom does no layout, so the Vitest/RTL suite cannot
 * verify that a persisted mid-feed scroll position actually round-trips through
 * SQLite and lands flash-free on the next boot. This drives a real Chromium
 * layout across TWO launches sharing ONE profile directory — the load-bearing
 * gate ADR 0054 promised for Batch 3.
 *
 * The pre-existing single-launch smoke (scripts/feed-scroll-smoke.mjs) gates the
 * scroll-ANCHORING primitives the restore builds on (anchor-to-end, stable anchor
 * after a backward jump, dock-toggle no-drift). This file is the complementary
 * end-to-end RESTORE gate and is intentionally a separate script so those three
 * assertions stay a clean, fast single-launch run.
 *
 * How the round-trip works (both directions verified):
 *   Launch 1 (profile A): seed an overflowing feed, reload so it mounts full,
 *     scroll to ~40% down (MID-feed — NOT the bottom), capture the top-visible
 *     note's identity + geometry, then wait past the capture throttle (~200ms) +
 *     the writer debounce (~250ms) so `feed.scroll.v1` is flushed to the
 *     profile's SQLite, and close WITHOUT deleting the profile.
 *   Launch 2 (SAME profile A): the app boots, `useSessionSnapshot` reads the
 *     persisted record, and <Feed> restores. We assert:
 *       (a) the top-visible note is the SAME note captured in Launch 1 (the
 *           anchor is preserved — within one row of estimate→measured shift), and
 *       (b) the restored position is CLEARLY mid-feed — its gap-from-end is more
 *           than a full viewport, proving the flash-free `initialOffset` seed took
 *           and virtual-core's `anchorTo:'end'` did NOT override it back to the
 *           bottom.
 *   Control (profile B, teeth): the SAME seeded notes with NO persisted scroll
 *     mount at the bottom (the default chat scroll-to-end). We read that
 *     no-restore top note + gap and assert it sits at the bottom on a LATER note
 *     than the restored mid note. This is what Launch 2 would look like if restore
 *     were broken — so it proves the round-trip assertions have teeth (a broken
 *     restore falls through to `scrollToEnd()`, failing both (a) and (b)).
 *
 * Run: pnpm rebuild:electron && pnpm smoke:feed-restore
 *      (build first if `out/` is stale: pnpm exec electron-vite build)
 *
 * @see scripts/feed-scroll-smoke.mjs (helper + launch/seed/teardown template)
 * @see adrs/0054-virtual-core-3.17-bump.md (Consequences: Batch-3 round-trip)
 * @see src/renderer/src/feed/Feed.tsx (restore seed + throttled takeSnapshot capture)
 * @see src/renderer/src/feed/feedScrollRestore.ts (pickFeedRestore: seed/index/bottom)
 * @see src/renderer/src/App.tsx (usePersistedWrite('feed.scroll.v1', …, debounceMs:250))
 */
import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron } from 'playwright'

// Comfortably overflows the 1280×800 default window (~60px/row) so ~40% down is
// solidly mid-feed and the bottom is many viewports away.
const SEED_COUNT = 120

// Sub-pixel layout rounding plus a possible scrollbar gutter make exact-pixel
// equality flaky; 4px is well below one row (~60px). @see feed-scroll-smoke.mjs.
const DRIFT_TOLERANCE_PX = 4

// The capture is trailing-throttled ~200ms (FEED_SCROLL_CAPTURE_THROTTLE_MS) and
// usePersistedWrite debounces 250ms before the `settings:set` IPC → SQLite write.
// Wait comfortably past both so the mid-feed position is on disk before we close.
const PERSIST_WAIT_MS = 1500

/**
 * The Feed's scroller: the only `.scroll-area-inner` element with a virtualized
 * `[data-index]` row descendant (disambiguates from a dock's own ScrollArea).
 * @see scripts/feed-scroll-smoke.mjs:feedScroller
 */
function feedScroller(win) {
  return win.locator('.scroll-area-inner').filter({ has: win.locator('[data-index]') })
}

/**
 * Reads the top-visible note's identity + geometry. There is no note-id DOM
 * attribute, so the seeded body text off `[data-bubble-body]` stands in for it
 * (unique per seed note). Also returns `gapFromEnd` (px from the bottom) and
 * `clientHeight` so callers can assert "clearly not at the bottom".
 * @see scripts/feed-scroll-smoke.mjs:topVisible
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
      gapFromEnd: el.scrollHeight - el.scrollTop - el.clientHeight,
      clientHeight: el.clientHeight,
    }
  })
}

/**
 * Polls `readFn()` until `done(latest, previous)` or `deadlineMs` elapses.
 * @see scripts/feed-scroll-smoke.mjs:poll
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

// Settled once `scrollTop` stops moving between two consecutive polls — the
// virtualizer has finished first-measurement / restore compensation.
const scrollTopSettled = (a, b) =>
  b !== null && Math.abs(a.scrollTop - b.scrollTop) <= DRIFT_TOLERANCE_PX

// Fully at the bottom AND settled: gap-from-end within tolerance. STRONGER than
// scrollTopSettled — it waits out the whole initial scrollToEnd() + last-row
// measurement cascade. Load-bearing before the mid-feed jump: jumping while that
// cascade is still in flight lets the re-pin yank the feed back to the bottom
// (empirically confirmed), so we must reach a quiet bottom first.
const atBottom = (g) => g.gapFromEnd <= DRIFT_TOLERANCE_PX

// Parse the sortable seed index out of a "seed note NNNN" body. The numeric
// distance between two seed notes is exactly their row distance, so it doubles
// as the "within one row" tolerance check.
const seedNum = (text) => {
  const m = /seed note (\d+)/.exec(text ?? '')
  return m ? Number(m[1]) : null
}

function launchApp(userDataDir) {
  return electron.launch({
    args: ['out/main/index.js', `--user-data-dir=${userDataDir}`],
  })
}

// Seed SEED_COUNT notes via real IPC, reload so the feed mounts the full set,
// and return the settled feed scroller. Reused by Launch 1 and the control.
async function seedAndMount(win, label) {
  console.log(`${label}: seeding ${SEED_COUNT} notes …`)
  await win.evaluate(async (count) => {
    for (let i = 0; i < count; i++) {
      await window.api.notes.create({ body: `seed note ${String(i).padStart(4, '0')}` })
    }
  }, SEED_COUNT)
  await win.reload()
  await win.waitForLoadState('domcontentloaded')
  const scroller = feedScroller(win)
  await scroller.waitFor({ timeout: 15000 })
  await win.locator('[data-index]').first().waitFor({ timeout: 15000 })
  return scroller
}

const userDataDirA = mkdtempSync(join(tmpdir(), 'linsae-feed-restore-A-'))
const userDataDirB = mkdtempSync(join(tmpdir(), 'linsae-feed-restore-B-'))

const results = {
  anchorPreserved: 'FAIL',
  notAtBottom: 'FAIL',
  teethControl: 'FAIL',
}

let captured = null
let restored = null
let control = null

try {
  // ── Launch 1 (profile A): seed, scroll to ~40%, persist, close ─────────────
  {
    const app = await launchApp(userDataDirA)
    try {
      const win = await app.firstWindow()
      await win.waitForLoadState('domcontentloaded')
      const scroller = await seedAndMount(win, 'launch-1')

      // Reach a QUIET bottom first: poll gap-from-end to tolerance so the initial
      // scrollToEnd() + last-row measurement cascade is fully done before we jump.
      // (A weaker scrollTop-settled check can return mid-cascade, and the jump then
      // races the re-pin straight back to the bottom.)
      await poll(() => topVisible(scroller), { done: (g) => atBottom(g), deadlineMs: 4000 })

      // Scroll to ~40% down — solidly MID-feed, NOT the bottom. isAtEnd() is false
      // here (gap ≫ scrollEndThreshold), so the persisted anchor is atEnd:false and
      // pickFeedRestore takes the seed (flash-free) path, not the bottom path.
      await scroller.evaluate((el) => {
        el.scrollTop = Math.round(el.scrollHeight * 0.4)
      })
      captured = await poll(() => topVisible(scroller), {
        done: scrollTopSettled,
        deadlineMs: 3000,
      })
      console.log(`launch-1: captured MID-feed anchor = ${JSON.stringify(captured)}`)
      assert.ok(captured.text, 'launch-1: expected a top-visible note at ~40%')
      assert.ok(seedNum(captured.text) !== null, `launch-1: unexpected body "${captured.text}"`)
      // Sanity that we actually landed mid-feed (many viewports from the bottom).
      assert.ok(
        captured.gapFromEnd > captured.clientHeight,
        `launch-1: expected a MID-feed capture, but gap-from-end ${captured.gapFromEnd} ≤ one viewport ${captured.clientHeight}`,
      )

      // Wait past the capture throttle (~200ms) + writer debounce (250ms) so
      // feed.scroll.v1 is flushed to the profile's SQLite before we close.
      console.log(`launch-1: waiting ${PERSIST_WAIT_MS}ms for the debounced persist to land …`)
      await new Promise((r) => setTimeout(r, PERSIST_WAIT_MS))
    } finally {
      await app.close()
    }
    console.log('launch-1: closed cleanly (profile A retained)')
  }

  // ── Launch 2 (SAME profile A): boot, restore, assert ───────────────────────
  {
    const app = await launchApp(userDataDirA)
    try {
      const win = await app.firstWindow()
      await win.waitForLoadState('domcontentloaded')
      // No seeding / no reload — the notes and the persisted scroll come from
      // profile A. Wait for the restored feed to mount and settle.
      const scroller = feedScroller(win)
      await scroller.waitFor({ timeout: 15000 })
      await win.locator('[data-index]').first().waitFor({ timeout: 15000 })
      restored = await poll(() => topVisible(scroller), {
        done: scrollTopSettled,
        deadlineMs: 3000,
      })
      console.log(`launch-2: restored anchor = ${JSON.stringify(restored)}`)
      assert.ok(restored.text, 'launch-2: expected a top-visible note after restore')

      // (a) Anchor preserved: the restored top note is the SAME note (within one
      // row of the legitimate estimate→measured shift). A restore that silently
      // landed at the top would show "seed note 0000" here; one that fell through
      // to scrollToEnd would show a late note — both are ≫ 1 row away.
      const dCaptured = seedNum(captured.text)
      const dRestored = seedNum(restored.text)
      assert.ok(
        dRestored !== null && Math.abs(dRestored - dCaptured) <= 1,
        `launch-2: anchor NOT preserved — captured "${captured.text}" but restored "${restored.text}"`,
      )
      results.anchorPreserved = 'PASS'
      console.log(
        `feed-scroll-restore [PASS] anchor preserved: "${captured.text}" → "${restored.text}"`,
      )

      // (b) Flash-free / anchorTo:'end' did NOT override: the restored position is
      // more than a full viewport from the bottom. A broken restore that fell back
      // to scrollToEnd() would sit at gap≈0 here and fail.
      assert.ok(
        restored.gapFromEnd > restored.clientHeight,
        `launch-2: restored position is at/near the BOTTOM (gap-from-end ${restored.gapFromEnd} ≤ one viewport ${restored.clientHeight}) — anchorTo:'end' overrode the restore`,
      )
      results.notAtBottom = 'PASS'
      console.log(
        `feed-scroll-restore [PASS] not-at-bottom: gap-from-end ${Math.round(restored.gapFromEnd)}px > viewport ${restored.clientHeight}px`,
      )
    } finally {
      await app.close()
    }
  }

  // ── Control (profile B, teeth): same notes, NO persisted scroll → bottom ────
  // This is exactly what Launch 2 would look like if restore were broken: the
  // default mount runs scrollToEnd(), landing at the bottom on a LATER note than
  // the restored mid anchor. It proves assertions (a)+(b) above have teeth.
  {
    const app = await launchApp(userDataDirB)
    try {
      const win = await app.firstWindow()
      await win.waitForLoadState('domcontentloaded')
      const scroller = await seedAndMount(win, 'control')
      // Poll to a quiet bottom (the default no-restore mount runs scrollToEnd()).
      control = await poll(() => topVisible(scroller), {
        done: (g) => atBottom(g),
        deadlineMs: 4000,
      })
      console.log(`control: no-restore default anchor = ${JSON.stringify(control)}`)
      assert.ok(control.text, 'control: expected a top-visible note on default mount')
      // Default lands at the bottom (gap ≈ 0)…
      assert.ok(
        control.gapFromEnd <= control.clientHeight,
        `control: expected the default mount at the BOTTOM, but gap-from-end ${control.gapFromEnd} > one viewport`,
      )
      // …on a note strictly LATER than the restored mid anchor — so the restore
      // genuinely moved the feed to a position the default would never produce.
      const dControl = seedNum(control.text)
      const dCaptured = seedNum(captured.text)
      assert.ok(
        dControl !== null && dControl > dCaptured,
        `control: no-restore top note "${control.text}" should be LATER than the restored mid note "${captured.text}"`,
      )
      results.teethControl = 'PASS'
      console.log(
        `feed-scroll-restore [PASS] teeth-control: no-restore lands at bottom on "${control.text}" (gap ${Math.round(control.gapFromEnd)}px) — later than restored "${captured.text}"`,
      )
    } finally {
      await app.close()
    }
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log('')
  console.log('feed-scroll-restore RESULTS:')
  console.log(`  anchor preserved (mid note round-trips): ${results.anchorPreserved}`)
  console.log(`  not at bottom (flash-free, no end-override): ${results.notAtBottom}`)
  console.log(`  teeth control (no-restore → bottom):     ${results.teethControl}`)
  console.log('')
  console.log(
    `  Launch-1 captured : "${captured?.text}" (gap ${Math.round(captured?.gapFromEnd)}px)`,
  )
  console.log(
    `  Launch-2 restored : "${restored?.text}" (gap ${Math.round(restored?.gapFromEnd)}px)`,
  )
  console.log(`  Control (default) : "${control?.text}" (gap ${Math.round(control?.gapFromEnd)}px)`)
  console.log('')

  if (results.anchorPreserved !== 'PASS' || results.notAtBottom !== 'PASS') {
    throw new Error('feed-scroll-restore: the RESTORE round-trip FAILED (see above)')
  }
  if (results.teethControl !== 'PASS') {
    throw new Error('feed-scroll-restore: the teeth control FAILED (see above)')
  }
} finally {
  rmSync(userDataDirA, { recursive: true, force: true })
  rmSync(userDataDirB, { recursive: true, force: true })
}
