// Playwright-Electron harness for debugging the feed expand/collapse morph.
// Launches the BUILT app in a throwaway profile (won't touch real notes nor
// collide with a running `pnpm dev` — per-userData single-instance lock).
// Seeds a long note + several short ones, then films expand and collapse from a
// scroll position where the notes BELOW are visible, with dense early frames to
// catch transient jumps. Reads virtualizer state straight from the DOM (no
// app-side probe), so it works on the production build.
//
// Prereq: pnpm rebuild:electron && pnpm exec electron-vite build
// Run:    node scripts/morph-harness.mjs   (screenshots → scripts/.morph-shots/)
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
    await win.waitForTimeout(180)
  }

  // TOP-EDGE case: long note FIRST (index 0, no scroll room above), shorts below.
  await send(longBody)
  for (let i = 1; i <= 5; i++) await send(`below note ${i}`)
  const LONG_INDEX = 0

  // Geometry of the long note (document top + height) so we can scroll it into
  // a position with the below-notes visible AND scroll room above it.
  const longGeom = () =>
    win.evaluate((i) => {
      const item = document.querySelector(`[data-index="${i}"]`)
      const scroller = item?.parentElement?.parentElement
      if (!item || !scroller) return { top: 0, height: 0 }
      const docTop =
        scroller.scrollTop + item.getBoundingClientRect().top - scroller.getBoundingClientRect().top
      return { top: docTop, height: item.offsetHeight }
    }, LONG_INDEX)
  const scrollTo = (px) =>
    win.evaluate(
      ([i, p]) => {
        const item = document.querySelector(`[data-index="${i}"]`)
        const scroller = item?.parentElement?.parentElement
        if (scroller) scroller.scrollTop = p
      },
      [LONG_INDEX, px],
    )
  const clickAria = (src) =>
    win.evaluate((s) => {
      const rx = new RegExp(s, 'i')
      const b = [...document.querySelectorAll('button')].find((x) =>
        rx.test(x.getAttribute('aria-label') || ''),
      )
      b?.click()
    }, src)
  // Sampler: per frame, the long note's on-screen bottom and the FIRST below-
  // note's on-screen top. If bottom-anchoring works, the below-note's top
  // stays ~constant; a rising number means it's being dragged up (the bug).
  const startSampler = (belowIndex) =>
    win.evaluate((bi) => {
      const w = window
      w.__s = []
      w.__on = true
      const tick = () => {
        if (!w.__on) return
        const long = document.querySelector(`[data-index="${bi - 1}"]`)
        const below = document.querySelector(`[data-index="${bi}"]`)
        const sc = long?.parentElement?.parentElement
        w.__s.push({
          t: Math.round(performance.now()),
          longBottom: long ? Math.round(long.getBoundingClientRect().bottom) : -1,
          belowTop: below ? Math.round(below.getBoundingClientRect().top) : -1,
          scrollTop: sc ? Math.round(sc.scrollTop) : -1,
        })
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    }, belowIndex)
  const film = async (prefix) => {
    let el = 0
    for (const ms of [0, 16, 40, 90, 160, 280]) {
      await win.waitForTimeout(ms - el)
      el = ms
      await win.screenshot({ path: `${SHOT_DIR}/${prefix}-${String(ms).padStart(3, '0')}ms.png` })
    }
  }

  // Expand the long note (so we then collapse it with content + below-notes in view).
  await win.getByRole('button', { name: /expand note/i }).waitFor({ timeout: 8000 })
  await clickAria('expand note')
  await win.waitForTimeout(450)

  // TOP-EDGE: scroll to the very top (no room to ride up). Below-notes are far
  // down past the tall expanded note.
  await longGeom()
  await scrollTo(0)
  await win.waitForTimeout(200)

  await startSampler(LONG_INDEX + 1)
  await clickAria('collapse')
  await film('collapse')
  await win.waitForTimeout(250)
  const s = await win.evaluate(() => {
    window.__on = false
    return window.__s
  })
  // Gap each frame = below-note top − long-note bottom (should be ~constant
  // inter-note spacing; a spike that shrinks = the chasing gap bug).
  console.log('gap trajectory:', JSON.stringify(s.map((x) => x.belowTop - x.longBottom)))
  // Frame intervals during the morph (≈16ms ⇒ 60fps; ≈33ms ⇒ flushSync tanked it).
  const intervals = s
    .slice(1)
    .map((x, i) => x.t - s[i].t)
    .filter((d) => d > 0)
  console.log('frame intervals (ms):', JSON.stringify(intervals))
  console.log('SCREENSHOTS:', SHOT_DIR)
} finally {
  await app.close()
}
