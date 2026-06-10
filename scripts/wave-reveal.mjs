// Playwright-Electron harness for the repulsion-wave feed ENTRANCE (v0.2.2 spike,
// src/renderer/src/dev/RevealPlayground.tsx). Agents can't see the Electron GUI, so
// this gives an OBJECTIVE, frame-by-frame answer to the one question the spike is
// stuck on:
//
//   When a note is sent in a WAVE model (flip/pbd), does the newcomer RISE from below
//   the fold, or does it POP straight to its final slot on frame 1?
//
// The discriminating measurement — sampled every rAF from just-before-send to settle:
//   relTop   = newcomer row's getBoundingClientRect().top - scroller.top  (its REAL
//              on-screen position; larger = lower in the viewport). THIS is ground truth.
//   wy       = the row's `--wy` custom prop = the per-row offset the MODEL is driving
//              (the spring animates it shift→0). This is what the model THINKS is happening.
//   scrollTop= the scroller's scrollTop. The suspected culprit: virtual-core's `wasAtEnd`
//              branch rides scrollTop by ~noteH the frame the newcomer is first measured,
//              which would cancel the visual offset → "pop".
//
// Healthy reveal:  relTop starts ≈ viewport bottom and DESCENDS to its rest slot over many
//                  frames; renderedRise ≈ newcomer height; scrollTop barely moves.
// The bug (pop):   relTop is already ≈ its rest value on frame 1 (renderedRise ≈ 0) EVEN
//                  THOUGH wy still animates shift→0 — because scrollTop jumped ~noteH to
//                  compensate. (model fine, screen frozen ⇒ the wasAtEnd scroll-snap.)
//
// Env:
//   MODEL=flip   flip | pbd | glide   (glide is the known-GOOD control — it should RISE)
//   SIZE=big     short | medium | big | huge   (the arriving note's height)
//   SETTLE=1600  ms to keep sampling after the send
//   FEED=playground  playground (default) | real  — which UI receives the measured send
//   SLOW=1       seed a large note set so the post-create notes.list refetch is slow;
//                exercises the §Guard (Task 4 sendInFlight clear) surviving a slow
//                non-optimistic round-trip. The newcomer must still RISE.
//
// Run (headless, off-screen):  xvfb-run -a node scripts/wave-reveal.mjs
// Watch it live:               node scripts/wave-reveal.mjs
// Prereq (your manual step): a build that KEEPS the dev playground + Electron-ABI sqlite:
//   node scripts/ensure-electron-abi.mjs && VITE_PLAYGROUND=1 pnpm exec electron-vite build
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron } from 'playwright'

const MODEL = process.env.MODEL ?? 'flip'
const SIZE = process.env.SIZE ?? 'big'
const SETTLE = Number(process.env.SETTLE ?? 1600)
// FEED=playground (default) — uses the dev RevealPlayground (Control+Shift+R).
// FEED=real        — uses the real composer + real [data-index] feed rows. Sets the
//                    linsae.feedEntrance pref before sending, seeds feed depth to
//                    overflow, then sends the measured note through the real textarea.
const FEED = process.env.FEED ?? 'playground'
// SLOW=1: seeds a large note-set (SLOW_SEED notes) so the post-create notes.list
// refetch is slow — exercises the §Guard (Task 4 sendInFlight clear) surviving a slow
// non-optimistic round-trip. Why: the append-coupled `sendInFlight` clear must NOT fire
// before the DB round-trip completes, even if the virtualizer update races it.
const SLOW = process.env.SLOW === '1'
const SLOW_SEED = 80 // ≫ REAL_SEED; large refetch list ⇒ slow round-trip
// TRACE=1     wrap the scroller's scrollTop setter + record a stack per JS write. If
//             scrollTop moves during the wave with NO setter write recorded, the browser
//             (CSS scroll anchoring) is moving it, not virtual-core.
// KILL_ANCHOR=1  set `overflow-anchor:none` on the scroller + content + every row before
//             the send — the minimal test of the scroll-anchoring hypothesis.
const TRACE = process.env.TRACE === '1'
const KILL_ANCHOR = process.env.KILL_ANCHOR === '1'
const SHOT_DIR = 'scripts/.wave-shots'

// ---------------------------------------------------------------------------
// Note bodies keyed by SIZE — used in real-Feed mode to pick a body whose
// rendered height matches the SIZE label.  Mirrors reveal-stress.mjs bodies.
// ---------------------------------------------------------------------------
const SIZE_BODIES = {
  short: 'short',
  medium:
    'a medium note whose body is long enough that it wraps across two or three lines in the bubble',
  big: Array.from(
    { length: 8 },
    (_, i) =>
      `paragraph ${i + 1} of a big multi-paragraph note — lots of text so the bubble is very tall and the make-room unroll has a long way to travel, which is when the overlap shows`,
  ).join('\n\n'),
  huge: Array.from(
    { length: 24 },
    (_, i) =>
      `paragraph ${i + 1} of a HUGE note taller than the whole viewport, so a naive scroll-glide that travels the full note height jumps the feed more than one screen`,
  ).join('\n\n'),
}

const userDataDir = mkdtempSync(join(tmpdir(), 'linsae-wave-'))
const app = await electron.launch({ args: ['out/main/index.js', `--user-data-dir=${userDataDir}`] })
try {
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')

  // App booted once the real composer textarea is up.
  const composer = win.locator('textarea').first()
  await composer.waitFor({ state: 'visible' })

  // -------------------------------------------------------------------------
  // MODE DISPATCH: playground vs real
  // -------------------------------------------------------------------------
  // rowSel      — CSS selector for virtual rows (unique attribute per mode).
  // idxAttr     — the attribute whose numeric value is the virtual index.
  // Newcomer identification (passed into installSampler per mode):
  //   playground: the single "arr*" row per send (id.startsWith('arr'));
  //   real:       the [data-index] row whose index exceeds the pre-send max
  //               (preMaxIndex, captured after the seed settles).
  // -------------------------------------------------------------------------

  let rowSel
  let idxAttr

  if (FEED === 'real') {
    rowSel = '[data-index]'
    idxAttr = 'data-index'

    // Set the feed entrance model BEFORE seeding so all notes arrive with the
    // correct entrance (avoids a pref-race where seed notes use a stale model).
    await win.evaluate((m) => {
      localStorage.setItem('linsae.feedEntrance', m)
      window.dispatchEvent(new Event('linsae:feed-entrance'))
    }, MODEL)
    await win.waitForTimeout(150)

    // Seed feed depth so the feed OVERFLOWS (the reveal rise needs room beneath
    // the fold; an empty/short feed has no room to rise from).
    // SLOW=1 seeds SLOW_SEED notes so the post-create notes.list refetch is slow —
    // exercising the §Guard (sendInFlight clear) surviving a slow round-trip.
    const seedCount = SLOW ? SLOW_SEED : 30
    for (let i = 1; i <= seedCount; i++) {
      await composer.click()
      await composer.fill(`seed note ${i} — some body text so the bubble has real height`)
      await composer.press('Enter')
      await win.waitForTimeout(200)
    }
    // Let the last seed's flight + reveal fully settle.
    await win.waitForTimeout(700)

    // Pin to the bottom (at-bottom overflowing case).
    await win.evaluate(() => {
      const sc = document.querySelector('[data-index]')?.parentElement?.parentElement
      if (sc) sc.scrollTop = sc.scrollHeight
    })
    await win.waitForTimeout(150)

    // Capture the pre-send max index so we can identify the newcomer row by
    // the fact that it has index === (old max + 1) after the send.
    const preMaxIndex = await win.evaluate(() => {
      const rows = [...document.querySelectorAll('[data-index]')]
      return rows.reduce((mx, r) => Math.max(mx, Number(r.getAttribute('data-index'))), -1)
    })

    // Optionally kill CSS scroll anchoring — same semantics as playground mode.
    if (KILL_ANCHOR) {
      await win.evaluate(() => {
        const row = document.querySelector('[data-index]')
        const content = row?.parentElement ?? null
        const scroller = content?.parentElement ?? null
        for (const el of [scroller, content]) {
          if (el) el.style.overflowAnchor = 'none'
        }
        for (const r of document.querySelectorAll('[data-index]')) {
          r.style.overflowAnchor = 'none'
        }
      })
    }

    // Install the per-rAF sampler (shared logic — see installSampler comment below).
    await installSampler(win, TRACE, rowSel, idxAttr, preMaxIndex)

    // SEND the measured note through the real composer.
    const measuredBody = SIZE_BODIES[SIZE] ?? SIZE_BODIES.big
    await composer.click()
    await composer.fill(`wave-measure· ${measuredBody}`)
    await composer.press('Enter')
  } else {
    // ---- PLAYGROUND MODE (default; identical to pre-Task-11 behaviour) ----
    rowSel = '[data-pw-id]'
    idxAttr = 'data-pw-index'

    // Open the dev playground (App's `mod+shift+R`; mod = Control on Linux). Focus the
    // textarea first — the open hotkey is bound with enableOnFormTags:['textarea','input'].
    await composer.click()
    await win.keyboard.press('Control+Shift+R')
    try {
      await win.locator('[data-pw-id]').first().waitFor({ state: 'visible', timeout: 4000 })
    } catch {
      throw new Error(
        'Playground never opened (no [data-pw-id] rows). Did the build keep it? ' +
          'Rebuild with VITE_PLAYGROUND=1, and check Control+Shift+R reached the renderer.',
      )
    }

    // Pick the model + arriving size via the two <select>s (selectOption fires React onChange).
    await win.locator('select:has(option[value="pbd"])').selectOption(MODEL)
    await win.locator('select:has(option[value="huge"])').selectOption(SIZE)
    await win.waitForTimeout(150) // let the panel re-render (glide swaps in the BezierTuner)

    // Make sure the playground feed is pinned to the bottom (its mount effect does this, but
    // be explicit) so the newcomer's rest slot is at the viewport's bottom edge.
    await win.evaluate(() => {
      const row = document.querySelector('[data-pw-id]')
      const sc = row?.parentElement?.parentElement
      if (sc) sc.scrollTop = sc.scrollHeight
    })
    await win.waitForTimeout(120)

    // Optionally kill CSS scroll anchoring on the scroller, its content wrapper, and every
    // row — the minimal test of "scroll anchoring is freezing the newcomer."
    if (KILL_ANCHOR) {
      await win.evaluate(() => {
        const row = document.querySelector('[data-pw-id]')
        const content = row?.parentElement ?? null
        const scroller = content?.parentElement ?? null
        for (const el of [scroller, content]) {
          if (el) el.style.overflowAnchor = 'none'
        }
        for (const r of document.querySelectorAll('[data-pw-id]')) {
          r.style.overflowAnchor = 'none'
        }
      })
    }

    // Install the per-rAF sampler. Playground newcomer is identified by
    // `[data-pw-id^="arr"]` + max data-pw-index; preMaxIndex is unused (pass -1).
    await installSampler(win, TRACE, rowSel, idxAttr, -1)

    // SEND (click the button — no focus/keyboard ambiguity). The append effect runs the wave.
    await win.locator('[data-testid="pg-play"]').click()
  }

  // Transient screenshot ~90ms in (mid-rise for a ~500ms settle), then the settled one.
  await win.waitForTimeout(90)
  await win.screenshot({
    path: `${SHOT_DIR}/01-rising-${MODEL}-${SIZE}-${FEED}${SLOW ? '-slow' : ''}.png`,
  })
  await win.waitForTimeout(SETTLE)
  await win.screenshot({
    path: `${SHOT_DIR}/02-settled-${MODEL}-${SIZE}-${FEED}${SLOW ? '-slow' : ''}.png`,
  })

  const { frames, scrollSets } = await win.evaluate(() => {
    window.__on = false
    return { frames: window.__frames, scrollSets: window.__scrollSets }
  })

  // ---------- Analysis (shared for both modes) ----------
  const present = frames.filter((f) => f.present)
  if (present.length < 3) {
    console.log('config:', JSON.stringify({ MODEL, SIZE, SETTLE, FEED, SLOW }))
    console.log(`RESULT: FAIL — newcomer never rendered (present frames=${present.length}).`)
  } else {
    const first = present[0]
    const rest = present[present.length - 1]
    const h = rest.h // settled true height ≈ the seed `shift`
    const renderedRise = first.relTop - rest.relTop // how far it CLIMBED on screen
    const modelRise = first.wy - rest.wy // how far the offset moved (≈ h if the model ran)
    const startedBelowFold = first.relTop >= first.clientH - 0.25 * h
    const scrollTops = present.map((f) => f.scrollTop)
    const scrollTopDelta = Math.max(...scrollTops) - Math.min(...scrollTops)
    const minGapEver = Math.min(...frames.filter((f) => f.minGap != null).map((f) => f.minGap))

    // THE discriminator between a gradual rise and a one-frame SNAP: the largest
    // single-frame change in relTop. A smooth rise spreads its travel over many frames
    // (max step ≪ total); a pop does ~all the travel in ONE frame (max step ≈ total).
    let maxStep = 0
    for (let i = 1; i < present.length; i++) {
      const step = Math.abs(present[i].relTop - present[i - 1].relTop)
      if (step > maxStep) maxStep = step
    }
    const snapRatio = renderedRise !== 0 ? maxStep / Math.abs(renderedRise) : 0

    // Trajectory: first ~12 present frames as [relTop, wy, scrollTop].
    console.log('config:', JSON.stringify({ MODEL, SIZE, SETTLE, FEED, SLOW }))
    console.log('frames sampled        :', frames.length, `(newcomer present in ${present.length})`)
    console.log('newcomer height (px)  :', h, '(= the seed shift the spring drives to 0)')
    console.log('first relTop (px)     :', first.relTop, `(viewport height=${first.clientH})`)
    console.log('  belowBottom (px)    :', first.belowBottom, '(>0 ⇒ entered from below the fold)')
    console.log('rest  relTop (px)     :', rest.relTop, '(its settled slot)')
    console.log(
      'RENDERED rise (px)    :',
      renderedRise,
      `(≈ height ⇒ it rose; ≈ 0 ⇒ it POPPED to slot)`,
    )
    console.log('MODEL rise via --wy   :', modelRise, '(≈ height ⇒ the spring ran)')
    console.log('scrollTop travel (px) :', scrollTopDelta, '(≈ height ⇒ scroll compensated = bug)')
    console.log(
      'max single-frame jump :',
      Math.round(maxStep),
      `px (${Math.round(snapRatio * 100)}% of the rise in ONE frame — ≈100% ⇒ a SNAP/pop)`,
    )
    console.log('min row gap ever (px) :', minGapEver, '(<0 ⇒ two notes overlapped some frame)')
    console.log('started below fold    :', startedBelowFold)
    console.log('\n  frame   relTop    wy   scrollTop   belowBottom')
    for (const f of present.slice(0, 12)) {
      console.log(
        `  ${String(f.t).padStart(6)}  ${String(f.relTop).padStart(6)}  ${String(f.wy).padStart(4)}  ${String(f.scrollTop).padStart(8)}  ${String(f.belowBottom).padStart(10)}`,
      )
    }

    // Verdict. A true RISE travels gradually from below the fold: ≥60% of its height of
    // total travel AND no single frame accounts for more than half of it (snapRatio<0.5).
    // A POP does ~all its on-screen travel in ONE frame (snapRatio≥0.5) — it teleports to
    // its slot — even if the total displacement looks large.
    const rises = renderedRise >= 0.6 * h && startedBelowFold && snapRatio < 0.5
    const pops = snapRatio >= 0.5
    const verdict = rises ? 'RISES ✓' : pops ? 'POPS ✗ (snaps to slot in one frame)' : 'AMBIGUOUS'
    console.log('\n---- VERDICT ----')
    console.log(`  newcomer entrance     : ${verdict}`)
    if (pops && modelRise >= 0.6 * h) {
      console.log(
        '  diagnosis             : the MODEL ran (--wy shift→0) but the SCREEN snapped to slot ' +
          'and froze ⇒ scrollTop is canceling the per-row offset.',
      )
    }
    if (SLOW) {
      console.log(
        '  SLOW mode             : seeded with',
        SLOW_SEED,
        'notes — a slow notes.list refetch was forced. ' +
          'If the newcomer RISES, the §Guard (sendInFlight clear) held across the slow round-trip.',
      )
    }
    if (TRACE) {
      console.log(
        '\nscroll JS writes      :',
        scrollSets.length,
        '(scrollTop= / scrollTo / scrollBy, with stacks)',
      )
      for (const s of scrollSets.slice(-16))
        console.log(`   t=${s.t} ${s.kind.padEnd(9)}→${String(s.v).padStart(5)}  ${s.top}`)
    }
    console.log(
      `\nRESULT: ${rises ? 'PASS — newcomer rises from below' : 'FAIL — newcomer does not rise'}`,
    )
    console.log(
      'SCREENSHOTS:',
      SHOT_DIR,
      `(01-rising / 02-settled, ${MODEL}-${SIZE}-${FEED}${SLOW ? '-slow' : ''})`,
    )
  }
} finally {
  await app.close()
}

// ---------------------------------------------------------------------------
// installSampler — shared per-rAF sampler, parameterized by row selector +
// index attribute so BOTH playground and real-Feed use identical metrics +
// verdict math.
//
// Parameters:
//   win         — Playwright Page (Electron window)
//   trace       — TRACE env bool (wrap scrollTop setter)
//   rowSel      — CSS selector for virtual rows:
//                   playground → '[data-pw-id]'
//                   real       → '[data-index]'
//   idxAttr     — attribute holding the virtual index number:
//                   playground → 'data-pw-index'
//                   real       → 'data-index'
//   preMaxIndex — the highest index seen BEFORE the send (real mode uses this to
//                 identify the newcomer; playground passes -1 and instead matches
//                 rows whose id starts with "arr").
// ---------------------------------------------------------------------------
async function installSampler(win, trace, rowSel, idxAttr, preMaxIndex) {
  await win.evaluate(
    ([traceArg, rowSelArg, idxAttrArg, preMaxArg]) => {
      const w = window
      w.__frames = []
      w.__on = true
      w.__scrollSets = []
      const sc0 = document.querySelector(rowSelArg)?.parentElement?.parentElement
      if (traceArg && sc0) {
        let proto = sc0
        let desc
        while (proto && !desc) {
          desc = Object.getOwnPropertyDescriptor(proto, 'scrollTop')
          proto = Object.getPrototypeOf(proto)
        }
        if (desc?.set) {
          const orig = desc.set
          Object.defineProperty(sc0, 'scrollTop', {
            configurable: true,
            get: desc.get,
            set(v) {
              w.__scrollSets.push({
                t: Math.round(performance.now()),
                kind: 'scrollTop=',
                v: Math.round(v),
                top: (new Error().stack ?? '').split('\n').slice(2, 5).join(' | '),
              })
              return orig.call(this, v)
            },
          })
        }
        // virtual-core writes scroll via el.scrollTo({top})/scrollBy (elementScroll),
        // NOT the scrollTop setter — wrap those too or its writes are invisible.
        for (const name of ['scrollTo', 'scrollBy']) {
          const fn = sc0[name]
          if (typeof fn === 'function') {
            sc0[name] = function (...a) {
              const arg = a[0]
              const v = typeof arg === 'object' && arg ? arg.top : arg
              w.__scrollSets.push({
                t: Math.round(performance.now()),
                kind: name,
                v: typeof v === 'number' ? Math.round(v) : v,
                top: (new Error().stack ?? '').split('\n').slice(2, 5).join(' | '),
              })
              return fn.apply(this, a)
            }
          }
        }
      }
      const tick = () => {
        if (!w.__on) return
        const rows = [...document.querySelectorAll(rowSelArg)]
        const content = rows[0]?.parentElement ?? null
        const scroller = content?.parentElement ?? null
        if (scroller) {
          const scr = scroller.getBoundingClientRect()
          // Find the newcomer row.
          // playground mode (preMaxArg === -1): the `arr*` row with the highest index.
          // real mode (preMaxArg >= 0): the row whose index > preMaxArg (the new append).
          let nc = null
          let ncIdx = -1
          for (const r of rows) {
            const id = r.getAttribute('data-pw-id') ?? ''
            const idx = Number(r.getAttribute(idxAttrArg))
            const isNewcomer =
              preMaxArg >= 0
                ? // real mode: any row whose virtual index is greater than what
                  // existed before the send
                  idx > preMaxArg && idx > ncIdx
                : // playground mode: the highest-indexed "arr*" row
                  id.startsWith('arr') && idx > ncIdx
            if (isNewcomer) {
              ncIdx = idx
              nc = r
            }
          }
          // Smallest gap between adjacent rendered rows (negative ⇒ two notes overlap).
          const rects = rows.map((r) => r.getBoundingClientRect())
          let minGap = Number.POSITIVE_INFINITY
          for (let i = 1; i < rects.length; i++) {
            const g = rects[i].top - rects[i - 1].bottom
            if (g < minGap) minGap = g
          }
          const frame = {
            t: Math.round(performance.now()),
            scrollTop: Math.round(scroller.scrollTop),
            clientH: scroller.clientHeight,
            scrollH: scroller.scrollHeight,
            minGap: Number.isFinite(minGap) ? Math.round(minGap * 10) / 10 : null,
            present: !!nc,
          }
          if (nc) {
            const rect = nc.getBoundingClientRect()
            const cs = getComputedStyle(nc)
            frame.relTop = Math.round(rect.top - scr.top) // position from viewport top
            frame.belowBottom = Math.round(rect.top - scr.bottom) // >0 ⇒ below the fold
            frame.h = Math.round(rect.height)
            frame.wy = Math.round(Number.parseFloat(cs.getPropertyValue('--wy')) || 0)
            frame.ty = Math.round(new DOMMatrixReadOnly(cs.transform).m42) // start + wy
          }
          w.__frames.push(frame)
        }
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    },
    [trace, rowSel, idxAttr, preMaxIndex],
  )
}
