// Playwright-Electron harness for the v0.2.1 send animation — the iMessage-style
// ghost that flies from the composer up into the feed (SendGhost +
// useSendAnimation) AND the make-room reveal that slides the new note up into
// place (useAppendReveal). Forked from morph-harness.mjs. It seeds notes, scrolls
// to the bottom, installs a per-rAF sampler that records the scroller's scrollTop
// (the reveal) and the ghost's rect + opacity each frame, sends one more note
// (triggering both), and reports the scrollTop ramp (smooth vs abrupt jump) plus
// the trajectory + the LANDING DRIFT of the ghost's final rect vs the real new
// note's rect — both vertical AND horizontal, since the geometry approximates
// `feedContentLeft` as the scroller's left edge and the harness is the arbiter
// of whether that drifts (see docs/specs/v0.2.1-send-animation.md §Verification).
//
// Reads state straight from the DOM (no app-side probe), so it works on the
// production build. Launches in a throwaway profile (won't touch real notes nor
// collide with a running `pnpm dev` — per-userData single-instance lock).
//
// Window-on-screen: this launches a real Electron window. To keep it OFF your
// screen, run headless under Xvfb (Linux):
//     pnpm harness:send                 # = xvfb-run -a node scripts/send-harness.mjs
// or watch it live:
//     node scripts/send-harness.mjs
//
// Prereq (electron ABI — your manual step): pnpm rebuild:electron && pnpm exec electron-vite build
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron } from 'playwright'

const SHOT_DIR = 'scripts/.send-shots'
const userDataDir = mkdtempSync(join(tmpdir(), 'linsae-send-harness-'))

const app = await electron.launch({ args: ['out/main/index.js', `--user-data-dir=${userDataDir}`] })
try {
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')

  const composer = win.locator('textarea').first()
  await composer.waitFor({ state: 'visible' })
  const send = async (text) => {
    await composer.click()
    await composer.fill(text)
    await composer.press('Enter')
    await win.waitForTimeout(220)
  }

  // Seed enough notes that the feed is taller than the viewport (tall-feed path:
  // the new note pins flush to the scroller bottom).
  for (let i = 1; i <= 8; i++) {
    await send(`seed note ${i} — some body text so the bubble has real height`)
  }

  // Pin to the bottom so the landing slot is on-screen.
  await win.evaluate(() => {
    const sc = document.querySelector('[data-index]')?.parentElement?.parentElement
    if (sc) sc.scrollTop = sc.scrollHeight
  })
  await win.waitForTimeout(150)

  // Per-rAF sampler: every frame record the scroller's scrollTop (the make-room
  // reveal, useAppendReveal) and — if the ghost exists — its rect + opacity.
  await win.evaluate(() => {
    const w = window
    w.__sg = []
    w.__st = []
    w.__sgOn = true
    const scroller = document.querySelector('[data-index]')?.parentElement?.parentElement ?? null
    const tick = () => {
      if (!w.__sgOn) return
      if (scroller) {
        w.__st.push({ t: Math.round(performance.now()), scrollTop: Math.round(scroller.scrollTop) })
      }
      const g = document.querySelector('[data-testid="send-ghost"]')
      if (g) {
        const r = g.getBoundingClientRect()
        w.__sg.push({
          t: Math.round(performance.now()),
          top: Math.round(r.top),
          left: Math.round(r.left),
          width: Math.round(r.width),
          height: Math.round(r.height),
          opacity: Number(getComputedStyle(g).opacity),
        })
      }
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })

  // Film the flight while sending the note that triggers the ghost.
  const film = async (prefix) => {
    let el = 0
    for (const ms of [0, 16, 40, 90, 160, 280, 420]) {
      await win.waitForTimeout(ms - el)
      el = ms
      await win.screenshot({ path: `${SHOT_DIR}/${prefix}-${String(ms).padStart(3, '0')}ms.png` })
    }
  }

  await composer.click()
  await composer.fill('the FLYING note — does it land on the real bubble?')
  await composer.press('Enter')
  await film('send')
  await win.waitForTimeout(350)

  // Stop sampling; read the trajectory + the settled landing geometry.
  const { sg, st } = await win.evaluate(() => {
    window.__sgOn = false
    return { sg: window.__sg, st: window.__st }
  })
  const landing = await win.evaluate(() => {
    const items = [...document.querySelectorAll('[data-index]')]
    const last = items[items.length - 1]
    if (!last) return null
    const r = last.getBoundingClientRect()
    return {
      top: Math.round(r.top),
      left: Math.round(r.left),
      width: Math.round(r.width),
      height: Math.round(r.height),
    }
  })
  const ghostGone = await win.evaluate(() => !document.querySelector('[data-testid="send-ghost"]'))

  // ---- Report (read the numbers; screenshots are a backstop) ----
  if (sg.length === 0) {
    console.log(
      'FAIL: ghost never appeared. Check prefers-reduced-motion (off under Xvfb?) and that the send fired.',
    )
  } else {
    const first = sg[0]
    const last = sg[sg.length - 1]
    const tops = sg.map((s) => s.top)
    // The ghost rises, so `top` should mostly DECREASE. Count meaningful upward
    // reversals (top growing > 1px) — a few near the end are the spring overshoot
    // settling, not a bug; many would mean the trajectory is wrong.
    let reversals = 0
    for (let i = 1; i < tops.length; i++) if (tops[i] > tops[i - 1] + 1) reversals++
    const intervals = sg
      .slice(1)
      .map((s, i) => s.t - sg[i].t)
      .filter((d) => d > 0)
    console.log('frames sampled        :', sg.length)
    console.log('top trajectory (px)   :', JSON.stringify(tops))
    console.log('opacity trajectory    :', JSON.stringify(sg.map((s) => s.opacity)))
    console.log('upward reversals      :', reversals, '(spring overshoot ok if small)')
    console.log('frame intervals (ms)  :', JSON.stringify(intervals), '(~16 ⇒ 60fps)')
    console.log('ghost start rect      :', JSON.stringify(first))
    console.log('ghost final rect      :', JSON.stringify(last))
    console.log('real landed note rect :', JSON.stringify(landing))
    if (landing) {
      console.log(
        'LANDING DRIFT         : Δtop',
        last.top - landing.top,
        ' Δleft',
        last.left - landing.left,
        ' Δwidth',
        last.width - landing.width,
        '  (small = the ghost dissolves onto the real note; large Δleft ⇒ feedContentLeft needs refining)',
      )
    }
    console.log('ghost cleaned up      :', ghostGone, '(removed from DOM at t≥1)')
  }

  // ---- make-room reveal: the feed should RAMP scrollTop up by ~one note height
  // (existing notes glide up, new note rises in), NOT jump it in a single frame.
  if (st && st.length > 1) {
    const tops = st.map((s) => s.scrollTop)
    const rise = Math.max(...tops) - Math.min(...tops)
    let maxStep = 0
    let risingFrames = 0
    for (let i = 1; i < tops.length; i++) {
      const d = tops[i] - tops[i - 1]
      if (d > 0) risingFrames++
      if (Math.abs(d) > maxStep) maxStep = Math.abs(d)
    }
    console.log('scrollTop rise (px)   :', rise, '(≈ one note height ⇒ the feed made room)')
    console.log('scrollTop max step    :', maxStep, '(≪ rise ⇒ smooth ramp; ≈ rise ⇒ abrupt jump)')
    console.log('scrollTop rising frms :', risingFrames, '(several ⇒ animated reveal, not a pop)')
    console.log('scrollTop trajectory  :', JSON.stringify(tops))
  } else {
    console.log('scrollTop trajectory  : (not captured — no scroller?)')
  }
  console.log('SCREENSHOTS           :', SHOT_DIR)
} finally {
  await app.close()
}
