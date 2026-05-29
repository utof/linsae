// Playwright-Electron harness for debugging the feed expand/collapse morph.
// Launches the BUILT app in a throwaway profile (won't touch real notes nor
// collide with a running `pnpm dev` — per-userData single-instance lock).
// Seeds a long note + several short ones, expands the long one, then samples
// virtualizer state from the DOM every animation frame across a collapse, and
// saves screenshots. Reads straight from the DOM (no app-side probe), so it
// works on the production build.
//
// Run: node scripts/morph-harness.mjs
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron } from 'playwright'

const SHOT_DIR = 'scripts/.morph-shots'
const userDataDir = mkdtempSync(join(tmpdir(), 'linsae-harness-'))
const longBody = 'Lorem ipsum dolor sit amet consectetur adipiscing elit. '.repeat(280) // ~15.7k chars

const app = await electron.launch({ args: ['out/main/index.js', `--user-data-dir=${userDataDir}`] })
try {
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')

  const composer = win.locator('textarea').first()
  await composer.waitFor({ state: 'visible' })

  async function send(text) {
    await composer.click()
    await composer.fill(text)
    await composer.press('Enter')
    await win.waitForTimeout(180) // let createMut → refetch land before the next send
  }

  // Long note FIRST (ends up at the top, index 0), then shorts below it — so a
  // collapse can show whether the notes BELOW stay put or vanish. (Can't gate on
  // a total bubble count: the feed auto-scrolls to the newest, so the top long
  // note virtualizes out of the DOM. Gate on the expand button after scrolling
  // back up instead.)
  await send(longBody)
  for (let i = 1; i <= 8; i++) await send(`short note ${i}`)

  // Scroll to the top so the long note is in view, then expand it.
  const scrollTop = () =>
    win.evaluate(() => {
      const item = document.querySelector('[data-index]')
      const scroller = item?.parentElement?.parentElement
      if (scroller) scroller.scrollTop = 0
    })
  await scrollTop()
  await win.waitForTimeout(250)
  await win.getByRole('button', { name: /expand note/i }).click({ timeout: 8000 })
  await win.waitForTimeout(400) // let expand settle
  await scrollTop()
  await win.waitForTimeout(150)

  // Per-frame sampler reading DOM-derived virtualizer state.
  await win.evaluate(() => {
    const w = window
    w.__samples = []
    w.__sampling = true
    const tick = () => {
      if (!w.__sampling) return
      const items = document.querySelectorAll('[data-index]')
      const first = items[0]
      const spacer = first?.parentElement
      const scroller = spacer?.parentElement
      // bubbles whose rendered box is empty-ish (height present but content short)
      w.__samples.push({
        t: Math.round(performance.now()),
        indexed: items.length,
        bubbles: document.querySelectorAll('[data-bubble]').length,
        scrollTop: scroller ? Math.round(scroller.scrollTop) : -1,
        total: spacer ? Math.round(spacer.offsetHeight) : -1,
        client: scroller ? scroller.clientHeight : -1,
      })
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })

  // Collapse while viewing the TOP of the note (the user's scenario). Click via
  // JS so Playwright does NOT auto-scroll the off-screen button into view —
  // scrollTop stays 0 (note's top filling the viewport). Filmstrip across the
  // morph to catch any transient empty band.
  // Scroll so the long note's BOTTOM sits ~200px below the viewport top, with
  // the short notes visible beneath it — the richest case for a visible
  // empty-clip band / "notes disappear".
  await win.evaluate(() => {
    const item = document.querySelector('[data-index="0"]')
    const scroller = item?.parentElement?.parentElement
    if (scroller && item) scroller.scrollTop = Math.max(0, item.offsetHeight - 200)
  })
  await win.waitForTimeout(120)
  await win.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) =>
      /collapse/i.test(x.getAttribute('aria-label') || ''),
    )
    b?.click()
  })
  let elapsed = 0
  for (const ms of [20, 60, 120, 200, 320]) {
    await win.waitForTimeout(ms - elapsed)
    elapsed = ms
    await win.screenshot({ path: `${SHOT_DIR}/collapse-${ms}ms.png` })
  }

  const samples = await win.evaluate(() => {
    window.__sampling = false
    return window.__samples
  })
  console.log('DOM_SAMPLES_COUNT:', samples.length)
  console.log('SCROLLTOP_TRAJECTORY:', JSON.stringify(samples.map((s) => s.scrollTop)))
  console.log('COUNT_TRAJECTORY:', JSON.stringify(samples.map((s) => s.indexed)))
  console.log('SCREENSHOTS:', SHOT_DIR)
} finally {
  await app.close()
}
