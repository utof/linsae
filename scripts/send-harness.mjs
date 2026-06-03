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
  for (let i = 1; i <= 30; i++) {
    await send(`seed note ${i} — some body text so the bubble has real height`)
  }

  // Let the last seed's ghost flight + make-room fully settle before filming —
  // seeds are fired ~220ms apart but a flight is ~460ms, so without this the
  // sampler catches the tail of seed #8's ghost (a false "flash"). Real sends are
  // seconds apart; this models a settled feed.
  await win.waitForTimeout(700)

  // Pin to the bottom so the landing slot is on-screen.
  await win.evaluate(() => {
    const sc = document.querySelector('[data-index]')?.parentElement?.parentElement
    if (sc) sc.scrollTop = sc.scrollHeight
  })
  await win.waitForTimeout(150)

  // Per-rAF sampler. Each frame record:
  //  - the content wrapper's translateY (the make-room reveal — useAppendReveal
  //    translates it from one note-height down back to 0 as the note stuffs in),
  //  - the newest note's opacity (hide-until-landing — it stays 0 while the ghost
  //    flies, flips to 1 on hand-off, so the two are never both visible),
  //  - the ghost's rect + opacity (the flight; opacity should stay ~1, no fade).
  await win.evaluate(() => {
    const w = window
    w.__sg = []
    w.__st = []
    w.__sgOn = true
    const anyItem = document.querySelector('[data-index]')
    const content = anyItem?.parentElement ?? null // the getTotalSize wrapper
    const readTY = (el) => {
      const m = new DOMMatrixReadOnly(getComputedStyle(el).transform)
      return Math.round(m.m42) // translateY
    }
    const tick = () => {
      if (!w.__sgOn) return
      const items = [...document.querySelectorAll('[data-index]')]
      const last = items[items.length - 1]
      if (content) {
        w.__st.push({
          t: Math.round(performance.now()),
          // Make-room is now a HEIGHT-unroll on the new (last) row, not a content
          // transform (ADR 0019 / useAppendReveal). Sample the last row's height
          // ramping 0→noteH; `ty` stays for back-compat but should hold ~0.
          ty: readTY(content),
          lastH: last ? Math.round(last.getBoundingClientRect().height) : null,
          lastOpacity: last ? Number(getComputedStyle(last).opacity) : null,
        })
      }
      const g = document.querySelector('[data-testid="send-ghost"]')
      if (g) {
        if (!w.__gp) {
          // One-time: confirm the ghost escaped to <body> and that no ancestor is
          // transformed (a transformed ancestor would drag the fixed ghost — ADR 0018).
          let transformed = null
          for (let el = g.parentElement; el; el = el.parentElement) {
            if (getComputedStyle(el).transform !== 'none') {
              transformed = el.tagName + (el.id ? `#${el.id}` : '')
              break
            }
          }
          w.__gp = { parent: g.parentElement?.tagName ?? null, transformedAncestor: transformed }
        }
        const r = g.getBoundingClientRect()
        const m = new DOMMatrixReadOnly(getComputedStyle(g).transform)
        w.__sg.push({
          t: Math.round(performance.now()),
          top: Math.round(r.top),
          left: Math.round(r.left),
          width: Math.round(r.width),
          height: Math.round(r.height),
          opacity: Number(getComputedStyle(g).opacity),
          ty: Math.round(m.m42), // the transform translateY Motion is applying
          cssTop: g.style.top, // the fixed `top` (should be constant)
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
  const { sg, st, gp } = await win.evaluate(() => {
    window.__sgOn = false
    return { sg: window.__sg, st: window.__st, gp: window.__gp }
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

  // ---- FULLY-SETTLED state (the bug report: note created but never visible).
  // Wait well past both the flight (460ms) and the reveal (400ms), then check the
  // newest note is opaque, on-screen, and the content transform/scroll recovered.
  await win.waitForTimeout(1500)
  const settled = await win.evaluate(() => {
    const items = [...document.querySelectorAll('[data-index]')]
    const last = items[items.length - 1]
    const content = items[0]?.parentElement ?? null
    const sc = content?.parentElement ?? null
    if (!last || !sc || !content) return null
    const lr = last.getBoundingClientRect()
    const scr = sc.getBoundingClientRect()
    const cty = Math.round(new DOMMatrixReadOnly(getComputedStyle(content).transform).m42)
    return {
      lastOpacity: Number(getComputedStyle(last).opacity),
      onScreen: lr.top >= scr.top - 1 && lr.bottom <= scr.bottom + 1,
      lastTop: Math.round(lr.top),
      lastBottom: Math.round(lr.bottom),
      scTop: Math.round(scr.top),
      scBottom: Math.round(scr.bottom),
      contentTransformY: cty,
      atBottom: Math.abs(sc.scrollTop - (sc.scrollHeight - sc.clientHeight)) < 2,
      scrollTop: Math.round(sc.scrollTop),
      maxScroll: Math.round(sc.scrollHeight - sc.clientHeight),
    }
  })

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
    console.log(
      'ghost transform ty    :',
      JSON.stringify(sg.map((s) => s.ty)),
      '(Motion translateY)',
    )
    console.log(
      'ghost css top         :',
      JSON.stringify([...new Set(sg.map((s) => s.cssTop))]),
      '(should be 1 constant)',
    )
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
    console.log(
      'ghost parent / xform  :',
      JSON.stringify(gp),
      '(want parent BODY, transformedAncestor null)',
    )
  }

  // ---- make-room reveal: the new (last) row's HEIGHT should RAMP 0→noteH over
  // several frames (the slot unrolls and pushes the feed up), NOT snap in a single
  // frame. (ADR 0019 / useAppendReveal — height-unroll via resizeItem, not a
  // content transform; `ty` should stay ~0.)
  if (st && st.length > 1) {
    const hs = st.map((s) => s.lastH).filter((h) => h != null)
    const span = Math.max(...hs) - Math.min(...hs)
    let maxStep = 0
    let movingFrames = 0
    for (let i = 1; i < hs.length; i++) {
      const d = Math.abs(hs[i] - hs[i - 1])
      if (d > 0) movingFrames++
      if (d > maxStep) maxStep = d
    }
    const tys = st.map((s) => s.ty)
    console.log(
      'content transform ty  :',
      JSON.stringify([...new Set(tys)]),
      '(want just [0] — no transform)',
    )
    console.log('make-room new-row H   : start', hs[0], '→ end', hs[hs.length - 1], '(≈ 0 → noteH)')
    console.log('make-room span (px)   :', span, '(≈ one note height ⇒ the slot unrolled)')
    console.log('make-room max step    :', maxStep, '(≪ span ⇒ smooth unroll; ≈ span ⇒ abrupt pop)')
    console.log('make-room moving frms :', movingFrames, '(several ⇒ animated unroll, not a pop)')
    console.log('make-room trajectory  :', JSON.stringify(hs))
    // hide-until-landing: while the ghost flies, the newest note must be invisible
    // (opacity 0) — that is what kills the "double note". It flips to 1 on hand-off.
    const opacities = st.map((s) => s.lastOpacity)
    const hiddenFrames = opacities.filter((o) => o === 0).length
    const shownFrames = opacities.filter((o) => o === 1).length
    console.log('newest-note opacity   :', JSON.stringify(opacities))
    console.log(
      'no-double-note        :',
      hiddenFrames > 0 && shownFrames > 0
        ? `OK — hidden ${hiddenFrames} frames then revealed ${shownFrames}`
        : `CHECK — hidden:${hiddenFrames} shown:${shownFrames} (want both >0)`,
    )
  } else {
    console.log('make-room trajectory  : (not captured — no content wrapper?)')
  }
  console.log('SETTLED (1.5s later)  :', JSON.stringify(settled))
  if (settled) {
    const ok = settled.lastOpacity === 1 && settled.onScreen && settled.contentTransformY === 0
    console.log(
      'NEWEST NOTE VISIBLE   :',
      ok ? 'OK' : 'FAIL',
      `(opacity ${settled.lastOpacity}, onScreen ${settled.onScreen}, contentTY ${settled.contentTransformY}, atBottom ${settled.atBottom})`,
    )
  }
  console.log('SCREENSHOTS           :', SHOT_DIR)
} finally {
  await app.close()
}
