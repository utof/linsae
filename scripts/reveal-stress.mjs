// Playwright-Electron STRESS harness for the make-room reveal (useAppendReveal)
// under RAPID / overlapping sends — the scenario the single-send send-harness.mjs
// cannot reach. This is the reconstituted `reveal-diag.mjs` (see issue #70),
// hardened: diverse note sizes, a configurable burst of sends fired faster than
// one reveal+flight settles, per-rAF sampling, and POST-SETTLE INVARIANTS that
// fail loudly when the feed is left in the #66 "white wall" / #67 overlap state.
//
// The bugs it targets (read straight from the DOM, so it works on the prod build):
//   #66 white wall — feed left translated-up, top notes hidden behind a blank
//        region; scrolling restores. Detected as a VIEWPORT-COVERAGE gap: when the
//        feed overflows and we are pinned to the bottom, every vertical band of the
//        scroller viewport must be covered by some rendered row's rect. An
//        uncovered band (esp. flush with the viewport top) IS the white wall.
//   #67 overlap — two note rects intersecting during/after a big-note send.
//        Detected as any pair of rendered row rects overlapping vertically.
//   reveal cleanup race — a row left clipped (`style.height`/`overflow` leftover)
//        or the content wrapper left with a stale inline `style.height`.
//
// Tunables (env):
//   SEED=30     seed notes (feed depth — 0 empty · 3 short/non-overflow · 30 overflow)
//   BURST=6     notes fired in the rapid burst
//   GAP=140     ms between burst sends (< reveal 400ms + flight 460ms ⇒ they overlap)
//   SETTLE=2200 ms to wait after the burst before asserting the settled invariants
//   TRACE=1     also wrap the scroller's scrollTop setter + record a stack per write
//
// Run (headless, off-screen):  pnpm harness:reveal
// Watch it live:               node scripts/reveal-stress.mjs
// Prereq (your manual step, electron ABI + a CURRENT bundle of the committed code):
//   pnpm rebuild:electron && pnpm exec electron-vite build
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron } from 'playwright'

const SEED = Number(process.env.SEED ?? 30)
const BURST = Number(process.env.BURST ?? 10)
const GAP = Number(process.env.GAP ?? 140)
const SETTLE = Number(process.env.SETTLE ?? 2200)
const TRACE = process.env.TRACE === '1'

// Burst note bodies, rotated — a mix of sizes so one run exercises both the
// white-wall (any size, rapid) and the big-note overlap (#67) paths.
const SHORT = 'short'
const WRAP =
  'a medium note whose body is long enough that it wraps across two or three lines in the bubble'
const BIG = Array.from(
  { length: 8 },
  (_, i) =>
    `paragraph ${i + 1} of a big multi-paragraph note — lots of text so the bubble is very tall and the make-room unroll has a long way to travel, which is when the overlap shows`,
).join('\n\n')
// HUGE is deliberately TALLER than the viewport, so its glide (= noteH) would
// exceed one screen — the condition for the big-note "jumps up then points to the
// bottom" glitch (the reveal scrolls more than a full viewport).
const HUGE = Array.from(
  { length: 24 },
  (_, i) =>
    `paragraph ${i + 1} of a HUGE note taller than the whole viewport, so a naive scroll-glide that travels the full note height jumps the feed more than one screen`,
).join('\n\n')
const SIZES = [SHORT, WRAP, BIG, SHORT, BIG, WRAP]
// ONLYSIZE=huge|big|wrap|short forces every burst send to one size — e.g.
// `BURST=1 ONLYSIZE=huge` isolates a single over-tall reveal (the "jumps up then
// points to the bottom" glitch).
const ONLY = { short: SHORT, wrap: WRAP, big: BIG, huge: HUGE }[process.env.ONLYSIZE ?? '']

const SHOT_DIR = 'scripts/.reveal-shots'
const userDataDir = mkdtempSync(join(tmpdir(), 'linsae-reveal-stress-'))
const app = await electron.launch({ args: ['out/main/index.js', `--user-data-dir=${userDataDir}`] })
try {
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')

  const composer = win.locator('textarea').first()
  await composer.waitFor({ state: 'visible' })
  const send = async (text, settleMs) => {
    await composer.click()
    await composer.fill(text)
    await composer.press('Enter')
    await win.waitForTimeout(settleMs)
  }

  // Seed the feed to the requested depth (settle each seed so the baseline is clean).
  for (let i = 1; i <= SEED; i++) {
    await send(`seed note ${i} — some body text so the bubble has real height`, 200)
  }
  await win.waitForTimeout(700) // let the last seed's flight + reveal fully settle

  // Pin to the bottom (the at-bottom, overflowing case is where the white wall bites).
  await win.evaluate(() => {
    const sc = document.querySelector('[data-index]')?.parentElement?.parentElement
    if (sc) sc.scrollTop = sc.scrollHeight
  })
  await win.waitForTimeout(150)

  // Install the per-rAF sampler. Each frame it computes a few LIGHTWEIGHT metrics
  // (the heavy per-row offender snapshot is taken once, at settle, below):
  //   maxBlankPx  — largest uncovered vertical band inside the scroller viewport
  //                 (only when the feed overflows); >epsilon ⇒ a white-wall frame.
  //   gapAtTopPx  — uncovered band flush with the viewport TOP (the reported shape).
  //   maxOverlapPx— largest vertical overlap between any two rendered row rects (#67).
  //   leftClips   — rendered rows left with an inline style.height (a leftover clip).
  await win.evaluate((trace) => {
    const w = window
    w.__rs = []
    w.__on = true
    w.__scrollSets = []
    const sc = document.querySelector('[data-index]')?.parentElement?.parentElement
    if (trace && sc) {
      // Wrap the scrollTop setter (it lives up the prototype chain on Element).
      let proto = sc
      let desc
      while (proto && !desc) {
        desc = Object.getOwnPropertyDescriptor(proto, 'scrollTop')
        proto = Object.getPrototypeOf(proto)
      }
      if (desc?.set) {
        const orig = desc.set
        Object.defineProperty(sc, 'scrollTop', {
          configurable: true,
          get: desc.get,
          set(v) {
            const stack = new Error().stack ?? ''
            w.__scrollSets.push({
              v: Math.round(v),
              top: stack.split('\n').slice(2, 5).join(' | '),
            })
            return orig.call(this, v)
          },
        })
      }
    }
    // Largest uncovered gap within [lo,hi] given covered [top,bottom] intervals.
    const gaps = (intervals, lo, hi) => {
      const sorted = intervals
        .map((r) => [Math.max(r.top, lo), Math.min(r.bottom, hi)])
        .filter(([a, b]) => b > a)
        .sort((a, b) => a[0] - b[0])
      let cursor = lo
      let max = 0
      let atTop = 0
      for (const [a, b] of sorted) {
        if (a > cursor) {
          const g = a - cursor
          if (g > max) max = g
          if (cursor === lo) atTop = g
        }
        if (b > cursor) cursor = b
      }
      if (hi > cursor) max = Math.max(max, hi - cursor) // trailing gap at the bottom
      return { max, atTop }
    }
    const tick = () => {
      if (!w.__on) return
      const rows = [...document.querySelectorAll('[data-index]')]
      const content = rows[0]?.parentElement ?? null
      const scroller = content?.parentElement ?? null
      if (scroller && content) {
        const scr = scroller.getBoundingClientRect()
        const overflow = scroller.scrollHeight - scroller.clientHeight > 2
        const rects = rows.map((r) => r.getBoundingClientRect())
        // Coverage gap — only meaningful when the feed overflows (a short feed sits
        // bottom-anchored with legitimate blank ABOVE the content).
        const { max: maxBlankPx, atTop: gapAtTopPx } = overflow
          ? gaps(rects, scr.top, scr.bottom)
          : { max: 0, atTop: 0 }
        // Largest vertical overlap between any two rendered row rects.
        let maxOverlapPx = 0
        for (let i = 0; i < rects.length; i++) {
          for (let j = i + 1; j < rects.length; j++) {
            const ov =
              Math.min(rects[i].bottom, rects[j].bottom) - Math.max(rects[i].top, rects[j].top)
            if (ov > maxOverlapPx) maxOverlapPx = ov
          }
        }
        const leftClips = rows.filter((r) => r.style.height !== '').length
        // The flying SendGhost (a position:fixed clone) is NOT a [data-index] row, so
        // row↔row overlap above misses it. Track its vertical overlap with any row
        // separately: mid-flight it occludes rows it passes (expected), but the
        // signal to watch is overlap PERSISTING at the landing frame (opacity→0) or
        // after the ghost should be gone — that reads as "two notes intersecting" (#67).
        const ghost = document.querySelector('[data-testid="send-ghost"]')
        let ghostOverlapPx = 0
        let ghostOpacity = null
        if (ghost) {
          ghostOpacity = Number(getComputedStyle(ghost).opacity)
          const gr = ghost.getBoundingClientRect()
          for (const rr of rects) {
            const ov = Math.min(gr.bottom, rr.bottom) - Math.max(gr.top, rr.top)
            const hov = Math.min(gr.right, rr.right) - Math.max(gr.left, rr.left)
            if (hov > 4 && ov > ghostOverlapPx) ghostOverlapPx = ov
          }
        }
        w.__rs.push({
          t: Math.round(performance.now()),
          maxBlankPx: Math.round(maxBlankPx),
          gapAtTopPx: Math.round(gapAtTopPx),
          maxOverlapPx: Math.round(maxOverlapPx),
          ghostOverlapPx: Math.round(ghostOverlapPx),
          ghostOpacity,
          leftClips,
          // scrollTop + the viewport height, to bound the reveal GLIDE distance: a
          // healthy glide moves at most ~one viewport; a glide that scrolls from the
          // very top to the bottom (a big note taller than the scroll range) is the
          // "jumps up then points to the bottom" big-note glitch.
          scrollTop: Math.round(scroller.scrollTop),
          clientH: scroller.clientHeight,
          contentH: content.style.height, // inline; '' once handed back to React
          atBottom:
            Math.abs(scroller.scrollTop - (scroller.scrollHeight - scroller.clientHeight)) < 2,
        })
      }
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }, TRACE)

  // The RAPID BURST — fire BURST sends as fast as the round-trip allows (GAP=0 by
  // default), so reveal N is still animating when reveal N+1 starts. Uses
  // keyboard.insertText (no select-all/clear round-trips that `fill` pays) so the
  // effective cadence is well under one reveal (400ms). This is what the single-send
  // harness never does, and what the user reproduces by "sending several in quick
  // succession." We record each send's wall-clock to report the REAL cadence, and
  // the sampler's `leftClips` tells us whether reveals actually overlapped (≥2).
  await composer.click()
  const sendTs = []
  for (let i = 0; i < BURST; i++) {
    sendTs.push(Date.now())
    // Prefix a per-send unique token at the START so the app's note-name uniqueness
    // check (derived from the opening line) never rejects a burst send — SIZES reuses
    // the same BIG/WRAP bodies, whose identical first lines would otherwise collide
    // ("Note with the name already exists") and silently drop that append.
    await win.keyboard.insertText(
      `b${i + 1}· ${ONLY ?? SIZES[i % SIZES.length]} [burst ${i + 1}/${BURST}]`,
    )
    await win.keyboard.press('Enter')
    if (GAP > 0) await win.waitForTimeout(GAP)
  }
  const gaps = sendTs.slice(1).map((t, i) => t - sendTs[i])
  const meanGap = gaps.length ? Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length) : 0

  // Screenshot the moment just after the burst (transient state) and the SETTLED
  // state (the persistent white wall) so the result can be eyeballed, not just
  // trusted from the numbers.
  await win.screenshot({ path: `${SHOT_DIR}/01-just-after-burst.png` })

  // Let everything settle, then take the authoritative settled snapshot + per-row
  // offenders for the invariant report.
  await win.waitForTimeout(SETTLE)
  await win.screenshot({ path: `${SHOT_DIR}/02-settled.png` })
  const { rs, scrollSets, settled } = await win.evaluate(() => {
    const w = window
    w.__on = false
    const rows = [...document.querySelectorAll('[data-index]')]
    const content = rows[0]?.parentElement ?? null
    const scroller = content?.parentElement ?? null
    let snap = null
    if (scroller && content) {
      const scr = scroller.getBoundingClientRect()
      const overflow = scroller.scrollHeight - scroller.clientHeight > 2
      // Box-model probe: the content wrapper has `marginTop:auto` (Feed.tsx ~584) to
      // bottom-anchor a short feed; it MUST collapse to 0 once the feed overflows.
      // If it is stuck non-zero while overflowing, THAT offset above the virtualizer's
      // content is the white wall (the virtualizer's scroll math doesn't know about it).
      const cs = getComputedStyle(content)
      const box = {
        contentMarginTop: Math.round(Number.parseFloat(cs.marginTop) || 0),
        contentOffsetTop: content.offsetTop, // px from the scroller's padding box top
        contentRectTopVsScroller: Math.round(content.getBoundingClientRect().top - scr.top),
        contentComputedH: Math.round(Number.parseFloat(cs.height) || 0),
        contentStyleH: content.style.height || '',
        contentTransformY: Math.round(new DOMMatrixReadOnly(cs.transform).m42),
        scrollerClientH: scroller.clientHeight,
        scrollerScrollH: scroller.scrollHeight,
        // What the scroll range SHOULD be if margin collapsed: contentH - clientH.
        impliedMaxScroll: Math.round((Number.parseFloat(cs.height) || 0) - scroller.clientHeight),
      }
      const info = rows.map((r) => {
        const rect = r.getBoundingClientRect()
        return {
          index: Number(r.getAttribute('data-index')),
          // translateY = the virtualizer's vItem.start (where it THINKS the row sits).
          // Compare consecutive rows' (ty + h): if row k's ty+h ≠ row k+1's ty, the
          // virtualizer's cached size for row k disagrees with its real height — the
          // measurement desync that opens the white wall.
          ty: Math.round(new DOMMatrixReadOnly(getComputedStyle(r).transform).m42),
          top: Math.round(rect.top),
          bottom: Math.round(rect.bottom),
          h: Math.round(rect.height),
          clip: r.style.height || '', // leftover inline clip, '' = clean
          overflowStyle: r.style.overflow || '',
        }
      })
      // Coverage gap at settle.
      const covered = info
        .map((r) => [Math.max(r.top, scr.top), Math.min(r.bottom, scr.bottom)])
        .filter(([a, b]) => b > a)
        .sort((a, b) => a[0] - b[0])
      let cursor = scr.top
      let maxBlank = 0
      let gapAtTop = 0
      for (const [a, b] of covered) {
        if (a > cursor) {
          const g = a - cursor
          if (g > maxBlank) maxBlank = g
          if (cursor === scr.top) gapAtTop = g
        }
        if (b > cursor) cursor = b
      }
      if (scr.bottom > cursor) maxBlank = Math.max(maxBlank, scr.bottom - cursor)
      // Overlapping pairs.
      const overlaps = []
      for (let i = 0; i < info.length; i++) {
        for (let j = i + 1; j < info.length; j++) {
          const ov = Math.min(info[i].bottom, info[j].bottom) - Math.max(info[i].top, info[j].top)
          if (ov > 2) overlaps.push({ a: info[i].index, b: info[j].index, ov: Math.round(ov) })
        }
      }
      // Where the virtualizer's tiling disagrees with reality: sort by index, and for
      // each adjacent pair flag when prev.ty+prev.h ≠ next.ty (a cached-size desync).
      const byIndex = [...info].sort((a, b) => a.index - b.index)
      const tiledGaps = []
      for (let i = 1; i < byIndex.length; i++) {
        const expected = byIndex[i - 1].ty + byIndex[i - 1].h
        const delta = byIndex[i].ty - expected
        if (Math.abs(delta) > 2) {
          tiledGaps.push({
            between: [byIndex[i - 1].index, byIndex[i].index],
            delta: Math.round(delta),
          })
        }
      }
      const last = rows[rows.length - 1]
      snap = {
        rowCount: info.length,
        box,
        rows: byIndex.map((r) => ({ i: r.index, ty: r.ty, h: r.h, top: r.top })),
        tiledGaps,
        overflow,
        atBottom:
          Math.abs(scroller.scrollTop - (scroller.scrollHeight - scroller.clientHeight)) < 2,
        scrollTop: Math.round(scroller.scrollTop),
        maxScroll: Math.round(scroller.scrollHeight - scroller.clientHeight),
        contentInlineH: content.style.height || '', // '' = handed back to React (clean)
        clipped: info.filter((r) => r.clip !== '' || r.overflowStyle !== ''),
        overlaps,
        maxBlank: Math.round(overflow ? maxBlank : 0),
        gapAtTop: Math.round(overflow ? gapAtTop : 0),
        lastOpacity: last ? Number(getComputedStyle(last).opacity) : null,
        lastTop: last ? Math.round(last.getBoundingClientRect().top) : null,
        scTop: Math.round(scr.top),
        scBottom: Math.round(scr.bottom),
      }
    }
    return { rs: w.__rs, scrollSets: w.__scrollSets, settled: snap }
  })

  // ---------- HEAL EXPERIMENT (root-cause confirmation) ----------
  // Hypothesis: the white wall is a range/scrollOffset desync — the virtualizer's
  // internal scrollOffset/scrollAdjustments drifted from the real scrollTop during the
  // rapid reveals, so it renders the wrong row window. virtual-core only re-syncs
  // (zeroes scrollAdjustments + re-ranges) when the offset ACTUALLY MOVES ≥1.5px (a
  // bare synthetic `scroll` event with no delta does nothing — confirmed). So model
  // the user's "scrolling restores" with a REAL nudge: scroll up, then back to bottom.
  // If that heals the gap → confirmed range/scrollOffset desync (the fix is to force
  // this re-sync at settle). If it survives a real scroll → a stale size/clip instead.
  const healed = await win.evaluate(() => {
    const rows = [...document.querySelectorAll('[data-index]')]
    const content = rows[0]?.parentElement ?? null
    const scroller = content?.parentElement ?? null
    if (!scroller || !content) return null
    scroller.scrollTop -= 80 // a real scroll up (fires the offset observer with a delta)
    scroller.dispatchEvent(new Event('scroll'))
    scroller.scrollTop = scroller.scrollHeight // back to the bottom
    scroller.dispatchEvent(new Event('scroll'))
    const scr = scroller.getBoundingClientRect()
    const covered = [...document.querySelectorAll('[data-index]')]
      .map((r) => r.getBoundingClientRect())
      .map((r) => [Math.max(r.top, scr.top), Math.min(r.bottom, scr.bottom)])
      .filter(([a, b]) => b > a)
      .sort((a, b) => a[0] - b[0])
    let cursor = scr.top
    let maxBlank = 0
    for (const [a, b] of covered) {
      if (a > cursor && a - cursor > maxBlank) maxBlank = a - cursor
      if (b > cursor) cursor = b
    }
    return { maxBlankAfterScroll: Math.round(maxBlank) }
  })
  await win.screenshot({ path: `${SHOT_DIR}/03-after-scroll-nudge.png` })

  // ---------- Report ----------
  const peakBlank = Math.max(0, ...rs.map((s) => s.maxBlankPx))
  const peakTopGap = Math.max(0, ...rs.map((s) => s.gapAtTopPx))
  const peakOverlap = Math.max(0, ...rs.map((s) => s.maxOverlapPx))
  const peakLeftClips = Math.max(0, ...rs.map((s) => s.leftClips))
  console.log('config                :', JSON.stringify({ SEED, BURST, GAP, SETTLE, TRACE }))
  console.log('frames sampled        :', rs.length)
  console.log('PEAK blank band (px)  :', peakBlank, '(any frame; >8 ⇒ a white-wall frame occurred)')
  console.log(
    'PEAK gap-at-top (px)  :',
    peakTopGap,
    '(blank flush with viewport top — the #66 shape)',
  )
  console.log(
    'PEAK row overlap (px) :',
    peakOverlap,
    '(>2 ⇒ two committed notes intersected — #67)',
  )
  const peakGhostOverlap = Math.max(0, ...rs.map((s) => s.ghostOverlapPx ?? 0))
  // Ghost overlap while it is still near-opaque (opacity > 0.5) — flight occlusion is
  // expected, but a near-opaque ghost sitting ON a row is what reads as a 2nd note.
  const landingGhostOverlap = Math.max(
    0,
    ...rs.filter((s) => (s.ghostOpacity ?? 0) > 0.5).map((s) => s.ghostOverlapPx ?? 0),
  )
  console.log(
    'PEAK ghost↔row (px)   :',
    peakGhostOverlap,
    `(flight occlusion — expected; near-opaque overlap=${landingGhostOverlap})`,
  )
  console.log(
    'PEAK leftover clips   :',
    peakLeftClips,
    peakLeftClips >= 2
      ? '(≥2 ⇒ reveals OVERLAPPED — the burst stressed the race)'
      : '(≤1 ⇒ reveals did NOT overlap — burst too slow to stress #66; fire faster)',
  )
  console.log('burst mean gap (ms)   :', meanGap, JSON.stringify(gaps), '(want ≪ 400 = one reveal)')
  // Reveal GLIDE distance: how far scrollTop travelled across the sampling window. A
  // healthy reveal glides at most ~one viewport (clientH); a glide ≫ clientH is the
  // big-note "jumps from the top down to the bottom" glitch.
  const scrollTops = rs.map((s) => s.scrollTop).filter((v) => v != null)
  const clientH = rs.find((s) => s.clientH != null)?.clientH ?? 0
  const glide = scrollTops.length ? Math.max(...scrollTops) - Math.min(...scrollTops) : 0
  console.log(
    'reveal glide (px)     :',
    glide,
    `(viewport=${clientH}; ≤ ~viewport ⇒ controlled; ≫ viewport ⇒ big-note jump-from-top)`,
  )
  if (TRACE) {
    console.log('scrollTop writes      :', scrollSets.length)
    for (const s of scrollSets.slice(-12)) console.log('   set', s.v, '←', s.top)
  }
  console.log('SETTLED               :', JSON.stringify(settled, null, 2))

  if (!settled) {
    console.log('\nRESULT: FAIL — could not read feed DOM (scroller/content not found).')
  } else {
    const inv = [
      ['no leftover row clip', settled.clipped.length === 0, JSON.stringify(settled.clipped)],
      [
        // The content wrapper's height IS getTotalSize (Feed.tsx sets it inline), so a
        // non-empty inline height is normal — the real invariant is that it equals the
        // scroller's scroll range (no phantom space, no stuck margin-top above it).
        'content height == scroll range',
        Math.abs(settled.box.contentComputedH - settled.box.scrollerScrollH) <= 8,
        `contentH=${settled.box.contentComputedH} scrollH=${settled.box.scrollerScrollH} marginTop=${settled.box.contentMarginTop}`,
      ],
      [
        'no two rows intersect (settled)',
        settled.overlaps.length === 0,
        JSON.stringify(settled.overlaps),
      ],
      // PER-FRAME intersection gates (not just settled): two notes must NEVER visually
      // intersect at ANY frame. Committed rows (row↔row) is the hard layout invariant;
      // the opaque flying ghost overlapping a note (it's pixel-identical, so it reads as
      // a 2nd note) is the "overshoots like crazy" intersection — gated near-opaque so a
      // fully-faded hand-off frame doesn't count.
      ['no row↔row intersect (any frame)', peakOverlap <= 2, `peak=${peakOverlap}px`],
      [
        'ghost never overlaps a note',
        landingGhostOverlap <= 40,
        `near-opaque ghost↔row peak=${landingGhostOverlap}px`,
      ],
      [
        'viewport fully covered (no white wall)',
        !settled.overflow || settled.maxBlank <= 8,
        `maxBlank=${settled.maxBlank} gapAtTop=${settled.gapAtTop}`,
      ],
      ['pinned to bottom', settled.atBottom, `scrollTop=${settled.scrollTop}/${settled.maxScroll}`],
      ['newest note visible', settled.lastOpacity === 1, `opacity=${settled.lastOpacity}`],
    ]
    // (The reveal GLIDE distance is reported above as a diagnostic, not gated: a note
    // taller than the viewport intentionally SNAPS to the bottom — moving >1 screen in
    // one step — so the correctness gate for big notes is the settled state below
    // (pinned to bottom, viewport fully covered, newest visible), not the glide size.)
    console.log('\n---- POST-SETTLE INVARIANTS ----')
    let failed = 0
    for (const [name, ok, detail] of inv) {
      if (!ok) failed++
      console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `   → ${detail}`}`)
    }
    console.log(
      `\nRESULT: ${failed === 0 ? 'PASS — feed clean after rapid sends' : `FAIL — ${failed} invariant(s) broken (bug reproduced)`}`,
    )
    if (settled.tiledGaps.length) {
      console.log(
        'TILING DESYNC         :',
        JSON.stringify(settled.tiledGaps),
        '(prev.ty+h ≠ next.ty ⇒ the virtualizer cached a wrong size for that row)',
      )
    }
  }
  console.log(
    'HEAL via real scroll  :',
    JSON.stringify(healed),
    '(maxBlank→0 ⇒ confirmed range/scrollOffset desync; a REAL scroll re-syncs it)',
  )
  console.log(
    'SCREENSHOTS           :',
    SHOT_DIR,
    '(01-just-after-burst, 02-settled, 03-after-scroll-event)',
  )
} finally {
  await app.close()
}
