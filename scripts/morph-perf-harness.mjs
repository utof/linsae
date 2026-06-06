// Playwright-Electron PERF harness for the feed expand/collapse morph on a
// KaTeX-heavy, over-cap note — the case the plain-text `morph-harness.mjs`
// cannot catch (it seeds Lorem ipsum with no KaTeX). Guards the #50 fix:
// collapsing a heavy note must NOT re-render the full <Markdown> up front to
// measure (that froze the tween ~1s in dev). See #50, #52 (residual onCommit).
//
// Seeds a ~70-section markdown note (headings/lists/inline KaTeX/wikilinks,
// >4096 chars so it's over-cap), expands it (which caches collapsed geometry),
// scrolls to the top, collapses, and samples per-frame rAF intervals.
//
// PASS/FAIL gate is the *tween*, not the whole window: a spike in the first 35%
// of frames = the up-front measure-freeze regression (#50) → exit 1. A single
// spike near the END is the expected `onCommit` truncation render (#52 residual)
// and is tolerated.
//
// Prereq (prod, the default):  pnpm rebuild:electron && pnpm exec electron-vite build
// Run (prod):                  node scripts/morph-perf-harness.mjs
// Run (dev, StrictMode off):   pnpm exec electron-vite dev --rendererOnly   # in another shell
//                              ELECTRON_RENDERER_URL=http://localhost:5173 node scripts/morph-perf-harness.mjs
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron } from 'playwright'

const IS_DEV = !!process.env.ELECTRON_RENDERER_URL
const HEAVY = Array.from(
  { length: 70 },
  (_, i) =>
    `## Section ${i}\nText with inline math $E_{${i}} = mc^2$ and a [[ref ${i}]] link here.\n- alpha ${i}\n- beta ${i}\n- gamma ${i}\n`,
).join('\n')

const userDataDir = mkdtempSync(join(tmpdir(), 'linsae-morph-perf-'))
const app = await electron.launch({ args: ['out/main/index.js', `--user-data-dir=${userDataDir}`] })
let failed = false
try {
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  if (IS_DEV) {
    // Match a real dev session that has toggled StrictMode off for animation work.
    await win.evaluate(() => localStorage.setItem('noStrict', '1'))
    await win.reload()
    await win.waitForLoadState('domcontentloaded')
  }
  const composer = win.locator('textarea').first()
  await composer.waitFor({ state: 'visible', timeout: 8000 })
  const send = async (t) => {
    await composer.click()
    await composer.fill(t)
    await composer.press('Enter')
    await win.waitForTimeout(200)
  }
  await send(HEAVY)
  await send('below note 1')
  await send('below note 2')

  const clickAria = (s) =>
    win.evaluate((x) => {
      const rx = new RegExp(x, 'i')
      ;[...document.querySelectorAll('button')]
        .find((b) => rx.test(b.getAttribute('aria-label') || ''))
        ?.click()
    }, s)

  await win.getByRole('button', { name: /expand note/i }).waitFor({ timeout: 8000 })
  await clickAria('expand note') // caches collapsed geometry (the #50 fix path)
  await win.waitForTimeout(2000) // a heavy full render can be slow in dev — wait it out
  await win.evaluate(() => {
    const sc = document.querySelector('[data-index="0"]')?.parentElement?.parentElement
    if (sc) sc.scrollTop = 0
  })
  await win.waitForTimeout(200)

  await win.evaluate(() => {
    const w = window
    w.__t = []
    w.__on = true
    const tk = () => {
      if (!w.__on) return
      w.__t.push(performance.now())
      requestAnimationFrame(tk)
    }
    requestAnimationFrame(tk)
  })
  await clickAria('collapse')
  await win.waitForTimeout(1200)
  const ts = await win.evaluate(() => {
    window.__on = false
    return window.__t
  })

  const ints = ts
    .slice(1)
    .map((t, i) => Math.round(t - ts[i]))
    .filter((d) => d > 0)
  const tween = ints.filter((d) => d <= 60)
  const tweenMean = (tween.reduce((a, b) => a + b, 0) / Math.max(1, tween.length)).toFixed(1)
  const max = Math.max(...ints)
  const maxPos = Math.round((ints.indexOf(max) / Math.max(1, ints.length)) * 100)
  // The #50 regression is a full-<Markdown> re-render freeze at the START
  // (~200ms+ in prod, ~800ms+ in dev). Tolerated: the inherent ~80ms first-frame
  // layout of heavy content, and the #52 onCommit render at the END. So only a
  // >150ms freeze in the tween's first third fails the gate.
  const renderFreeze = ints.slice(0, Math.ceil(ints.length * 0.35)).some((d) => d > 150)
  const env = IS_DEV ? 'DEV(noStrict)' : 'PROD'
  console.log(
    `[${env}] frames=${ints.length} tween-mean=${tweenMean}ms max=${max}ms@${maxPos}% renderFreeze=${renderFreeze}`,
  )
  if (renderFreeze) {
    console.error(
      'FAIL: >150ms freeze in the first third of the tween — #50 regression (full <Markdown> re-render on collapse).',
    )
    failed = true
  } else {
    console.log(
      'PASS: no up-front render freeze (a spike near the end is the expected #52 onCommit residual).',
    )
  }
} finally {
  await app.close()
}
process.exit(failed ? 1 : 0)
