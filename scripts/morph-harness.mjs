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

  // Long note FIRST (top, index 0), then shorts below it.
  await send(longBody)
  for (let i = 1; i <= 8; i++) await send(`short note ${i}`)

  const itemH = () =>
    win.evaluate(() => document.querySelector('[data-index="0"]')?.offsetHeight ?? 0)
  const scrollTo = (px) =>
    win.evaluate((p) => {
      const item = document.querySelector('[data-index="0"]')
      const scroller = item?.parentElement?.parentElement
      if (scroller) scroller.scrollTop = p
    }, px)
  // JS click (no Playwright auto-scroll) so the scroll position we set holds.
  const clickAria = (src) =>
    win.evaluate((s) => {
      const rx = new RegExp(s, 'i')
      const b = [...document.querySelectorAll('button')].find((x) =>
        rx.test(x.getAttribute('aria-label') || ''),
      )
      b?.click()
    }, src)
  const film = async (prefix) => {
    let el = 0
    for (const ms of [0, 16, 40, 90, 160, 280]) {
      await win.waitForTimeout(ms - el)
      el = ms
      await win.screenshot({ path: `${SHOT_DIR}/${prefix}-${String(ms).padStart(3, '0')}ms.png` })
    }
  }

  // EXPAND — scroll so the collapsed note's bottom + the shorts are visible, so
  // the downward growth + below-notes movement are on-screen.
  await win.getByRole('button', { name: /expand note/i }).waitFor({ timeout: 8000 })
  await scrollTo((await itemH()) - 220)
  await win.waitForTimeout(150)
  await clickAria('expand note')
  await film('expand')
  await win.waitForTimeout(250)

  // COLLAPSE — scroll so the expanded note's bottom + the shorts are visible.
  await scrollTo((await itemH()) - 220)
  await win.waitForTimeout(150)
  await clickAria('collapse')
  await film('collapse')
  await win.waitForTimeout(250)

  console.log('SCREENSHOTS:', SHOT_DIR)
} finally {
  await app.close()
}
