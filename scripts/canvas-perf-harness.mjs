// Playwright-Electron perf-gate harness for the v0.4 canvas (spec §3 + §17).
// Adapted from scripts/spike-canvas/run.mjs — same GPU guard + vsync probe +
// stats(), but it drives the REAL app's camera through window.__canvasHarness
// (Task 1 bridge) instead of the spike's vanilla window.Spike.
//
// SEEDING (B1/B4): this harness imports NO better-sqlite3. It launches with an
// empty tmp --user-data-dir + LINSAE_HARNESS=1, then seeds 500 notes by calling
// the app's OWN window.api.canvas.createNoteAt IPC inside the page. createNoteAt
// is file-first (writes <userDataDir>/notes/<id>.md then the DB row, ONE txn —
// spec §7). Boot reconcile (src/main/db/reconcile.ts soft-deletes any DB note NOT
// on disk) ran once at launch on the EMPTY DB before seeding, and win.reload()
// reloads only the renderer (no reconcile re-run), so the seeded notes are never
// tombstoned; the .md files keep them safe across a full relaunch too. A
// direct-SQLite seed would be tombstoned (B1) AND would ABI-collide with the
// launched Electron app over the one better-sqlite3 binding (B4). A reload is
// REQUIRED after seeding because a raw IPC call does not invalidate the renderer
// react-query cache; the remounted canvas re-reads the 500 committed rows.
//
// THREE measured phases map to the §3 gates:
//   churn  — wide pan across the board so cards mount/unmount entering the
//            viewport: gate p95 ≤ 33.4ms, mean ≥ 55fps, zero frames > 100ms.
//   steady — small oscillation inside an already-mounted region (no new mounts):
//            gate p95 ≤ 18ms.
//   dot    — forceTier:'dot' + 10k synthetic dots + unclamp zoom, then zoom FAR
//            and center on the dot field so ~all 10k are VISIBLE, oscillate:
//            gate p95 ≤ 18ms (measures 10k visible dots — #124).
// Each phase runs 3×; the verdict uses the MEDIAN run by mean fps (pinned
// protocol). Prints vsync p50 + GPU status FIRST and ABORTS (exit 1) if vsync
// isn't ~16.7ms (15–18ms tolerance) or the GPU is software-rendered; ALSO aborts
// if the board is empty after seed+reload (the B1 safety net).
//
// Run on the REAL display session — NEVER under xvfb/ssh: software GL invalidates
// results (same hard rule as the spike). NOT a lefthook gate (ABI + display).
//
// Prereq (operator's manual step — ONE; the harness imports no better-sqlite3, so
// there is NO rebuild:node):
//   pnpm rebuild:electron && pnpm exec electron-vite build   # build the app (electron ABI)
//   pnpm harness:canvas                                      # = node scripts/canvas-perf-harness.mjs
//
// @see docs/specs/v0.4-canvas-mvp.md §3 §17 §7
// @see scripts/spike-canvas/run.mjs (GPU guard + vsync probe transcribed here)
// @see scripts/spike-canvas/page/harness.js (stats() transcribed here)
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron } from 'playwright'

// Operator-facing abort (bad GPU / wrong vsync / empty board / tier-flip fail /
// mid-run rAF throttle). Carries `expected = true` so the top-level catch prints
// just the message (no stack — these are NOT bugs) and still routes through the
// `finally` cleanup (app.close + rmSync) so an aborted run leaks no tmpdir (#126).
class AbortError extends Error {
  expected = true
}

// ---- §3 gates (exact). churn vs steady vs dot, each judged on the median run.
const GATES = {
  churn: { meanFps: 55, p95: 33.4, over100: 0 },
  steady: { p95: 18 },
  dot: { p95: 18 },
}
const SEED = 42
const COUNT = 500
const WORLD = { w: 5000, h: 3300 }
// Mirrors CanvasStage SYNTHETIC_DOT_SPREAD: the 10k synthetic dots scatter over
// a DOT_SPREAD×DOT_SPREAD world field. The dot phase zooms FAR (zoom ≈ 0.1, the
// spike's baseZ) and centers on the field so ~all 10k dots are on-screen — the
// gate then measures 10k VISIBLE dots (spec §3), not the ~1 dot visible at the
// zoom-1 camera inherited from the steady phase. @issue utof/linsae#124
const DOT_SPREAD = 10000
const DOT_ZOOM = 0.1
const CARD_W = 360 // CanvasStage CARD_WIDTH
const CARD_H = 140 // CanvasStage DEFAULT_CARD_HEIGHT
const RUNS = 3
const PHASE_MS = 8000 // per-phase choreography duration
// Mid-run rAF-throttle tripwire (#126). The start-of-run vsync probe only catches
// a display ALREADY asleep; the screen can DPMS-blank DURING an 8s phase (or a
// waitForTimeout gap), and Chromium then throttles rAF to ~1Hz (p50 ≈ 1000ms).
// Gate on the run's MEDIAN frame interval (p50), not p95/max: a real perf
// regression keeps a low-ish median with occasional spikes, but only genuine
// throttling drags the MEDIAN to ~1000ms. 100ms is 6× the worst plausible good
// frame (16.7ms) and 10× below the ~1Hz floor — an unambiguous band.
const THROTTLE_P50_MS = 100
// Culling mounts only viewport-intersecting cards, so NOT all 500 are in the DOM
// at once; this floor just proves seeding + reconcile didn't wipe the board (B1).
const MIN_CARDS = 50

// ---- stats(): VERBATIM from scripts/spike-canvas/page/harness.js:40-56.
// Stringified + injected into the page (win.evaluate) so the rAF timestamps are
// reduced renderer-side, exactly as the spike does it.
const STATS_FN = `
function stats(ts) {
  const ints = []
  for (let i = 1; i < ts.length; i++) ints.push(ts[i] - ts[i - 1])
  const sorted = [...ints].sort((a, b) => a - b)
  const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]
  const total = ts[ts.length - 1] - ts[0]
  return {
    frames: ints.length,
    meanFps: +((ints.length / total) * 1000).toFixed(1),
    p50: +q(0.5).toFixed(1),
    p95: +q(0.95).toFixed(1),
    p99: +q(0.99).toFixed(1),
    max: +sorted[sorted.length - 1].toFixed(1),
    over17: ints.filter((d) => d > 17).length,
    over100: ints.filter((d) => d > 100).length,
  }
}`

// ---- seed the board via the app's createNoteAt IPC, inside the page. mulberry32
// (spike-faithful) scatters the cards deterministically over the world so a wide
// pan crosses mount boundaries. Sequential awaited calls (file-first + fsync +
// txn) — ~2.5–5s for 500, fine for one-time setup. Returns the count placed.
async function seedViaIpc(win) {
  return win.evaluate(
    async ([count, seed, world, cardW, cardH]) => {
      // mulberry32 (spike-faithful PRNG) so a fixed seed → an identical board.
      let a = seed >>> 0
      const rand = () => {
        a = (a + 0x6d2b79f5) | 0
        let t = Math.imul(a ^ (a >>> 15), 1 | a)
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
      }
      let placed = 0
      for (let i = 0; i < count; i++) {
        // Each note's heading "# Seed note ${i}" → slug "seed note ${i}"
        // (slugFromBody: heading-stripped + lowercased). Note 1 wikilinks the
        // REAL slug of note 0 ([[Seed note 0]] → normalizeSlug → "seed note 0"),
        // so replaceLinksForNote writes a resolvable 'reference' links row
        // (1 → 0) that canvasEdges returns once both are placed — the smoke's
        // reference-edge sub-test needs a reference edge that actually RENDERS
        // (a dangling [[wikilink]] would not). All other notes keep a dangling
        // [[wikilink]] (no seeded note has that slug) → those draw nothing.
        const ref = i === 1 ? '[[Seed note 0]]' : '[[wikilink]]'
        const body =
          `# Seed note ${i}\n\nProse with **emphasis** and a ${ref}, long enough ` +
          `to wrap a few lines like a real note body. Inline math $e^{i\\pi}+1=0$.`
        await window.api.canvas.createNoteAt({
          canvasId: 'root',
          arrangementId: 'manual',
          body,
          type: 'claim',
          x: 100 + rand() * (world.w - cardW - 200),
          y: 100 + rand() * (world.h - cardH - 200),
        })
        placed++
      }
      return placed
    },
    [COUNT, SEED, WORLD, CARD_W, CARD_H],
  )
}

// ---- one phase: drive the bridge camera along a cosine path for durationMs,
// recording a rAF timestamp each frame, then reduce with stats(). `mode` picks
// the path: 'churn' = wide pan, 'steady'/'dot' = tiny oscillation about current
// cam. Before the 'dot' phase the runner forces the dot tier AND sets a FAR zoom
// centered on the synthetic field (DOT_ZOOM), so the dot oscillation happens
// there — `base = getCamera()` reads zoom 0.1 with ~10k dots visible. setCamera is the
// UNCLAMPED Dispatch (clamping lives only in the gesture helpers, which the bridge
// never touches), so {x,y,zoom} are written verbatim. Runs entirely in the page so
// the rAF clock and the setCamera writes share a frame (the spike's runChoreo).
// MOTION-LOD: churn/steady drive setCamera through the bridge → useCanvasCamera's
// moveCamera → bump() (useCanvasCamera.ts:106-112), re-arming the 120ms settle timer
// each frame, so isMoving stays TRUE the whole phase. Cards therefore render the
// motion-LOD placeholder/skeleton (NoteCard.tsx:110 `showFull = !isMoving || upgradedRef.current`),
// so these phases measure the §3-credited motion-LOD/amortization path — correct,
// but note `upgradedRef` latches once-upgraded-never-demote → run-to-run nondeterminism.
async function runPhase(win, mode, durationMs) {
  return win.evaluate(
    async ([m, dur, statsSrc, world]) => {
      const stats = new Function(`${statsSrc}; return stats`)()
      const h = window.__canvasHarness
      if (!h) throw new Error('window.__canvasHarness missing — isHarness not set?')
      const base = h.getCamera()
      // churn pans clear across the world at zoom 1 (crosses mount boundaries);
      // steady/dot oscillate ±60 world px about the current camera (no new mounts).
      const start = { x: 200, y: world.h / 2, zoom: 1 }
      const end = { x: world.w - 200, y: world.h / 2, zoom: 1 }
      const ts = []
      await new Promise((resolve) => {
        let t0
        const tick = (now) => {
          if (t0 === undefined) t0 = now
          const t = (now - t0) / dur
          if (t >= 1) {
            resolve()
            return
          }
          if (m === 'churn') {
            const u = 0.5 - 0.5 * Math.cos(t * Math.PI * 2) // there-and-back
            h.setCamera({
              x: start.x + (end.x - start.x) * u,
              y: start.y,
              zoom: 1,
            })
          } else {
            const u = 0.5 - 0.5 * Math.cos(t * Math.PI * 4)
            h.setCamera({ x: base.x + 60 * u, y: base.y + 40 * u, zoom: base.zoom })
          }
          ts.push(now)
          requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      })
      return stats(ts)
    },
    [mode, durationMs, STATS_FN, WORLD],
  )
}

// median of an array of run-stats BY meanFps (pinned protocol).
function medianByMeanFps(runs) {
  const sorted = [...runs].sort((a, b) => a.meanFps - b.meanFps)
  return sorted[Math.floor(sorted.length / 2)]
}

// ── SMOKE FLOW (--smoke) ───────────────────────────────────────────────────────
// A SEPARATE code path (does NOT run the perf gates) that drives REAL pointers via
// win.mouse against the seeded board to verify the Plan-3 interactions wired in
// happy-dom-untestable territory actually fire. It reuses the shared setup (launch
// + GPU/vsync guard + IPC-seed + reload + switch-to-canvas + board-non-empty guard)
// and runs INSTEAD of the 3 phases. Each assertion prints `OK <label>` or
// `FAIL <label>`; runSmoke returns 1 if ANY failed, else 0. Verifies these issues:
//   #119 — drag-commit invalidation flash (the card must NOT jump back to origin
//          on any frame right after mouse.up before settling at the new spot).
//   #121 — double-click OVER a card edits (opens [data-canvas-card-editor]) and
//          does NOT create (the [data-note-id] count is unchanged).
//   #111 — keep-alive abandonment under the §6 Motion slide: toggling feed↔canvas
//          mid-interaction must leave a clean canvas (world present, dragged card
//          present, no orphaned [data-canvas-ghost]) after the canvas remounts.
//   B3   — a plain click (down→up, no move) on a TRULY-empty surface point
//          DESELECTS the selected card (guards the phantom-occupancy `hitVisibleAt`
//          fix: a click on a culled/keep-alive rect must not reselect a ghost).
//   B4   — the §14 G2 "back to your notes" centroid pill ([data-canvas-centroid-arrow])
//          APPEARS when panned into empty world space (zero cards truly visible) and
//          is ABSENT when centered on the board; its arrow glyph points at the centroid.
// @see scripts/canvas-perf-harness.mjs (shared setup) · @see send-harness.mjs (trajectory print)

// Read the on-screen rect of a card by its data-note-id (viewport-relative client
// coords via getBoundingClientRect — what the pointer sees), or null if not mounted.
async function noteRect(win, noteId) {
  return win.evaluate((id) => {
    const el = document.querySelector(`[data-note-id="${id}"]`)
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: r.x, y: r.y, w: r.width, h: r.height }
  }, noteId)
}

// The data-note-id of the card whose center is nearest the given client point AND
// whose rect lies fully inside the viewport (so a drag/dblclick lands on it, not a
// half-culled edge card). Returns null if none qualify — the caller then FAILs.
async function pickCardNear(win, cx, cy) {
  return win.evaluate(
    ([px, py]) => {
      const vp = document.querySelector('[data-canvas-viewport]')
      if (!vp) return null
      const v = vp.getBoundingClientRect()
      let best = null
      let bestD = Number.POSITIVE_INFINITY
      for (const el of document.querySelectorAll('[data-note-id]')) {
        const r = el.getBoundingClientRect()
        const inside =
          r.left >= v.left && r.top >= v.top && r.right <= v.right && r.bottom <= v.bottom
        if (!inside) continue
        const dx = r.x + r.width / 2 - px
        const dy = r.y + r.height / 2 - py
        const d = dx * dx + dy * dy
        if (d < bestD) {
          bestD = d
          best = { id: el.getAttribute('data-note-id'), x: r.x, y: r.y, w: r.width, h: r.height }
        }
      }
      return best
    },
    [cx, cy],
  )
}

// The data-note-id of the single card the PRODUCT currently has selected (its
// shell carries the §8 selection ring → a non-`none` computed box-shadow), or
// null if zero / more-than-one are ringed. The board seeds 500 cards densely
// over a 5000×3300 world, so at zoom 1 cards OVERLAP: a click lands inside
// several cards' rects and `onWorldPointerDown` selects the TOPMOST (the rbush
// `hit[last]` = highest placed_at, CanvasStage.tsx:913) — NOT necessarily the
// nearest-center card a harness-side scan would guess. So we never assume WHICH
// card a click grabs; we read it back from the product's own ring. Why exactly
// one: the assertions that use this start from a cleared selection + a single
// primary click, so >1 ring means stale state and we bail rather than mis-measure.
async function selectedCardId(win) {
  return win.evaluate(() => {
    const ringed = []
    for (const el of document.querySelectorAll('[data-note-id]')) {
      const bs = getComputedStyle(el).boxShadow
      if (bs && bs !== 'none') ringed.push(el.getAttribute('data-note-id'))
    }
    return ringed.length === 1 ? ringed[0] : null
  })
}

// Find a viewport-relative client point the PRODUCT classifies as EMPTY surface
// (a pointerdown there begins a marquee, not a card drag). We CANNOT reuse a
// DOM probe (elementFromPoint / rect scan): the product hit-tests the rbush
// spatial index, which keys off each row's world x/y + DEFAULT_CARD_HEIGHT for
// unmeasured cards AND still contains keep-alive (display:none) rows — so the
// index disagrees with the painted DOM, and a DOM-"empty" point can still be a
// card per `index.search` (this was the original bug: the create/marquee grid
// scans found DOM-empty points the product treated as occupied). Instead we ask
// the PRODUCT: trial a short pointerdown+move at each grid point; if a
// [data-canvas-marquee] appears the point is genuinely empty (surface path).
// Cancel each trial with esc (clears the just-started marquee + any selection)
// so probing is side-effect-free. Returns {x,y} or null if none of the grid is
// empty (a 500-card board still has gaps; the grid is fine-grained enough).
async function findEmptyPoint(win, vp) {
  for (let gy = 0.15; gy <= 0.85; gy += 0.06) {
    for (let gx = 0.15; gx <= 0.85; gx += 0.06) {
      const px = vp.x + vp.width * gx
      const py = vp.y + vp.height * gy
      await win.mouse.move(px, py)
      await win.mouse.down()
      await win.mouse.move(px + 20, py + 18)
      await win.mouse.move(px + 40, py + 36)
      const isEmpty = (await win.locator('[data-canvas-marquee]').count()) > 0
      await win.mouse.up()
      await win.keyboard.press('Escape')
      await win.waitForTimeout(40)
      if (isEmpty) return { x: px, y: py }
    }
  }
  return null
}

// Fire a double-click the canvas's `onDoubleClick` handlers actually receive, at
// a viewport-relative client point. Why NOT win.mouse.dblclick: the canvas calls
// viewport.setPointerCapture(e.pointerId) on the FIRST pointerdown of any
// gesture (useCanvasInteractions.ts:178/196), and Playwright's synthetic
// click→dblclick is then RETARGETED to the capturing viewport — so the dblclick
// lands on the viewport, never on the card shell (NoteCard onDoubleClick) nor the
// world surface (onSurfaceDoubleClick), and neither React handler fires. (Verified
// on real hardware: mouse.dblclick emits a dblclick event but with the wrong
// target → editor/composer never opens.) A real user's double-click is delivered
// by the OS without that synthetic-capture retarget; we reproduce the user-visible
// event by dispatching a bubbling `dblclick` MouseEvent on the true topmost
// element at the point (document.elementFromPoint), carrying the real clientX/Y so
// onSurfaceDoubleClick's screenToWorld lands on the intended world coord. This
// exercises the product's own handler — it is not a product workaround.
async function dblclickAt(win, x, y) {
  await win.evaluate(
    ([px, py]) => {
      const el = document.elementFromPoint(px, py)
      if (!el) return
      el.dispatchEvent(
        new MouseEvent('dblclick', { bubbles: true, cancelable: true, clientX: px, clientY: py }),
      )
    },
    [x, y],
  )
}

// Drive the smoke assertions. `out` collects [label, ok] like the gate's `checks`.
// Returns 0 if all passed, 1 if any FAILed (caller sets exitCode).
async function runSmoke(win) {
  const out = []
  const assert = (label, ok) => {
    out.push([label, !!ok])
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}`)
  }

  const vp = await win.locator('[data-canvas-viewport]').boundingBox()
  if (!vp) {
    console.error('FAIL: viewport has no bounding box — cannot drive pointers.')
    return 1
  }
  // A point well inside the viewport, away from edges, as the drag start anchor.
  const probe = { x: vp.x + vp.width * 0.45, y: vp.y + vp.height * 0.45 }

  // ── Drag-to-move + commit (§8) + #119 (no commit-flash back to origin) ────────
  // `pickCardNear` chooses WHERE to press (a real card's on-screen center), but
  // because the seeded cards overlap, the product may select a DIFFERENT (topmost)
  // card than the one whose center we targeted — so we never measure the picked
  // card. After mouse.down we read back the card the PRODUCT actually selected
  // (its ring) via selectedCardId, capture ITS origin, and measure THAT card for
  // the move / #119 / settle. (Without this the harness measured a stationary
  // neighbour while the genuinely-dragged topmost card moved — the original FAIL.)
  const pick = await pickCardNear(win, probe.x, probe.y)
  if (!pick) {
    assert('drag: a fully-visible card to grab', false)
    return out.filter(([, ok]) => !ok).length > 0 ? 1 : 0
  }
  const startC = { x: pick.x + pick.w / 2, y: pick.y + pick.h / 2 }
  const DELTA = { x: 220, y: -140 } // enough to clear the §8 drag threshold + be visible
  await win.mouse.move(startC.x, startC.y)
  await win.mouse.down()
  // Which card did the product grab? (topmost under the press — read its ring.)
  const dragId = await selectedCardId(win)
  const origin = dragId ? await noteRect(win, dragId) : null
  // A few steps so the move is a real drag, not a teleport (matches send-harness).
  for (let i = 1; i <= 5; i++) {
    await win.mouse.move(startC.x + (DELTA.x * i) / 5, startC.y + (DELTA.y * i) / 5)
  }
  await win.mouse.up()
  if (!dragId || !origin) {
    assert('drag: product selected a single card on press', false)
  } else {
    const originX = origin.x
    // #119: sample the dragged card's rect across the frames right after mouse.up.
    // If the commit invalidation flashes, the card snaps back toward its ORIGIN
    // for ≥1 frame before re-settling at the dragged spot. Capture ~12 rAF frames.
    const flash = await win.evaluate(
      ([id, frames]) =>
        new Promise((resolve) => {
          const xs = []
          const sample = () => {
            const el = document.querySelector(`[data-note-id="${id}"]`)
            xs.push(el ? +el.getBoundingClientRect().x.toFixed(1) : null)
            if (xs.length >= frames) resolve(xs)
            else requestAnimationFrame(sample)
          }
          requestAnimationFrame(sample)
        }),
      [dragId, 12],
    )
    console.log('drag x-trajectory (px):', JSON.stringify(flash)) // like send-harness `top trajectory`
    await win.waitForTimeout(400) // let the commit settle
    const settled = await noteRect(win, dragId)
    const movedX = settled ? settled.x - originX : 0
    const movedY = settled ? settled.y - origin.y : 0
    // The drag delta is in SCREEN px at zoom 1, so the card should land ≈DELTA away.
    assert(
      'drag-to-move commit: card landed ≈ drag delta and stayed (§8)',
      settled !== null && Math.abs(movedX - DELTA.x) < 80 && Math.abs(movedY - DELTA.y) < 80,
    )
    // #119: a flash is any sampled frame whose x is back near the origin (within
    // 40px) while the settled position is far from it (the card genuinely moved).
    const reallyMoved = Math.abs(movedX) > 80
    const flashed = reallyMoved && flash.some((x) => x !== null && Math.abs(x - originX) < 40)
    assert('#119 no drag-commit flash: card never snapped back to origin post-up', !flashed)
  }
  // Clear the post-drag selection so it does not bleed into the marquee assertion.
  await win.keyboard.press('Escape')
  await win.waitForTimeout(150)

  // ── Marquee select (§8): rubber-band ≥2 cards → ≥2 selection rings ────────────
  // Start the band on a point the PRODUCT treats as empty surface (findEmptyPoint
  // trials the product's own marquee classification — see its doc), then drag a
  // wide rect. A DOM elementFromPoint scan was the original bug: it found points
  // the product's spatial index still considered occupied (keep-alive + unmeasured-
  // height rows), so the press began a card drag and no marquee ever appeared.
  const emptyPt = await findEmptyPoint(win, vp)
  if (!emptyPt) {
    assert('marquee: an empty surface point to start the band', false)
  } else {
    await win.mouse.move(emptyPt.x, emptyPt.y)
    await win.mouse.down()
    // Rubber-band a large rect across much of the viewport (covers many cards).
    let marqueeSeen = false
    for (let i = 1; i <= 6; i++) {
      await win.mouse.move(emptyPt.x + 60 * i, emptyPt.y + 50 * i)
      if (!marqueeSeen) {
        marqueeSeen = (await win.locator('[data-canvas-marquee]').count()) > 0
      }
    }
    assert('marquee appeared mid-drag ([data-canvas-marquee])', marqueeSeen)
    await win.mouse.up()
    await win.waitForTimeout(200)
    // A selected card has box-shadow '0 0 0 2px var(--accent), var(--shadow-2)'
    // (NoteCard.tsx:163); in computed style the var resolves to rgb, so a selected
    // shell has a non-`none` box-shadow. Count shells with a non-none box-shadow.
    const ringCount = await win.evaluate(() => {
      let n = 0
      for (const el of document.querySelectorAll('[data-note-id]')) {
        const bs = getComputedStyle(el).boxShadow
        if (bs && bs !== 'none') n++
      }
      return n
    })
    console.log(`selected shells (non-none box-shadow): ${ringCount}`)
    assert('marquee selected ≥2 cards (selection ring on ≥2 shells §8)', ringCount >= 2)
    // Clear the selection so it does not bleed into the next assertions.
    await win.keyboard.press('Escape')
    await win.waitForTimeout(150)
  }

  // ── B3: a plain click on a TRULY-empty point deselects (guards the phantom- ────
  // occupancy fix `hitVisibleAt`, CanvasStage.tsx:566-574/979-997). The escaped
  // happy-dom bug: the rbush index counted culled + keep-alive (display:none) rows
  // as occupied, so onWorldPointerDown routed an empty-point pointerdown to
  // onCardPointerDown (reselect) instead of onSurfacePointerDown (marquee). A bare
  // marquee with NO movement + NO modifier clears the selection
  // (useCanvasInteractions.ts:269 `if (!mq.moved && !mq.additive) setSelectedIds(new Set())`).
  // State-bleed order: capture the empty point FIRST — findEmptyPoint ends by
  // pressing Escape (clears any selection), so we select AFTER it returns.
  const deselectPt = await findEmptyPoint(win, vp)
  if (!deselectPt) {
    assert('B3: an empty point to test click-deselect', false)
  } else {
    // Select a card with a single primary click (down→up, no move = a 0,0 drag,
    // no commit). pickCardNear targets a center; the product selects the topmost
    // under the press — read it back via the §8 selection ring (selectedCardId).
    const selCard = await pickCardNear(win, probe.x, probe.y)
    if (!selCard) {
      assert('B3: a fully-visible card to select', false)
    } else {
      const sc = { x: selCard.x + selCard.w / 2, y: selCard.y + selCard.h / 2 }
      await win.mouse.move(sc.x, sc.y)
      await win.mouse.down()
      await win.mouse.up()
      await win.waitForTimeout(120)
      const ringedId = await selectedCardId(win)
      assert('B3 click selected exactly one card (1 selection ring §8)', ringedId !== null)
      // The deselect: a PLAIN click (down→up, SAME coords, no movement) on the
      // empty point. No move → marquee `moved` stays false → pointerup clears.
      await win.mouse.move(deselectPt.x, deselectPt.y)
      await win.mouse.down()
      await win.mouse.up()
      await win.waitForTimeout(120)
      const stillRinged = await win.evaluate(() => {
        let n = 0
        for (const el of document.querySelectorAll('[data-note-id]')) {
          const bs = getComputedStyle(el).boxShadow
          if (bs && bs !== 'none') n++
        }
        return n
      })
      console.log(`selection rings after empty-click: ${stillRinged} (expect 0)`)
      assert('B3 click on empty surface deselected (0 selection rings)', stillRinged === 0)
    }
    await win.keyboard.press('Escape') // belt-and-suspenders before the next block
    await win.waitForTimeout(120)
  }

  // ── #121: double-click OVER a card edits, does NOT create ─────────────────────
  const beforeEdit = await win.locator('[data-note-id]').count()
  const editCard = await pickCardNear(win, probe.x, probe.y)
  if (!editCard) {
    assert('#121: a fully-visible card to double-click', false)
  } else {
    const ec = { x: editCard.x + editCard.w / 2, y: editCard.y + editCard.h / 2 }
    await dblclickAt(win, ec.x, ec.y)
    await win.waitForTimeout(300)
    const editorOpen = (await win.locator('[data-canvas-card-editor]').count()) > 0
    const afterEdit = await win.locator('[data-note-id]').count()
    assert('#121 dblclick-over-card opened in-place editor ([data-canvas-card-editor])', editorOpen)
    assert(
      '#121 dblclick-over-card did NOT create a card (count unchanged)',
      afterEdit === beforeEdit,
    )
    await win.keyboard.press('Escape') // close the editor
    await win.waitForTimeout(200)
  }

  // ── Placement via double-click-create (§5/§7) — the robust path ───────────────
  // The `/` picker is NOT used here: every seeded note is already PLACED, so the
  // picker would JUMP to a match (onJump) rather than place a NEW card — the count
  // never increases. Double-click-create (the plan's offered substitute) creates a
  // genuinely new note → [data-note-id] count +1, proving the placement wiring.
  const beforeCreate = await win.locator('[data-note-id]').count()
  // The empty point MUST be empty per the product's spatial index, not the DOM:
  // onSurfaceDoubleClick early-returns when `index.search(point)` is non-empty
  // (CanvasStage.tsx:891), so a DOM-empty-but-index-occupied point opened no
  // composer — the original [data-canvas-create] timeout. findEmptyPoint uses the
  // product's own marquee classification, which shares that index hit-test.
  const createPt = await findEmptyPoint(win, vp)
  if (!createPt) {
    assert('placement: an empty point to double-click-create', false)
  } else {
    await dblclickAt(win, createPt.x, createPt.y)
    await win.locator('[data-canvas-create]').waitFor({ state: 'visible', timeout: 4000 })
    // The create composer's textarea (Composer.tsx) — fill (which focuses it; no
    // explicit click, which would re-enter the setPointerCapture retarget) then
    // Enter submits (Composer onKeyDown: Enter without shift → onSubmit, Composer.tsx:163).
    const ta = win.locator('[data-canvas-create] textarea')
    await ta.fill('Smoke placed note')
    await win.keyboard.press('Enter')
    await win.waitForTimeout(500) // create txn + invalidate + refreshCanvas + remount
    const afterCreate = await win.locator('[data-note-id]').count()
    console.log(`cards before/after create: ${beforeCreate} → ${afterCreate}`)
    assert(
      'placement via double-click-create added a card (count +1, §7)',
      afterCreate === beforeCreate + 1,
    )
  }

  // ── #111: keep-alive abandonment under the §6 Motion slide ────────────────────
  // Toggle feed↔canvas mid-interaction (right after a drag). Toggling to feed
  // UNMOUNTS CanvasStage → its guarded effect runs uninstallHarnessBridge(), so the
  // bridge is gone on the feed view. So we assert PURELY via DOM after the canvas
  // remounts (S2). First do a small drag to be "mid-interaction".
  const tCard = await pickCardNear(win, probe.x, probe.y)
  let toggledCardId = null
  if (tCard) {
    toggledCardId = tCard.id
    const tc = { x: tCard.x + tCard.w / 2, y: tCard.y + tCard.h / 2 }
    await win.mouse.move(tc.x, tc.y)
    await win.mouse.down()
    await win.mouse.move(tc.x + 40, tc.y + 30)
    await win.mouse.up()
  }
  // Toggle to feed then back to canvas (platform-aware MOD, NOT a hardcoded Meta).
  await win.keyboard.press(`${MOD}+1`)
  await win.waitForTimeout(250)
  await win.keyboard.press(`${MOD}+2`)
  // Wait for the canvas to REMOUNT (world attached) before asserting (the §6
  // AnimatePresence exit can interrupt the render — this is the #111 guard).
  // 'attached' not 'visible': the world is a 0-size transform container.
  await win.locator('[data-canvas-world]').waitFor({ state: 'attached', timeout: 8000 })
  await win.waitForTimeout(400)
  const worldBack = (await win.locator('[data-canvas-world]').count()) > 0
  const cardBack = toggledCardId
    ? (await win.locator(`[data-note-id="${toggledCardId}"]`).count()) > 0
    : (await win.locator('[data-note-id]').count()) > 0
  const noGhost = (await win.locator('[data-canvas-ghost]').count()) === 0
  assert('#111 canvas remounted after feed↔canvas toggle (world present)', worldBack)
  assert('#111 dragged card still present after toggle (no abandonment)', cardBack)
  assert('#111 no orphaned ghost after toggle ([data-canvas-ghost] count 0)', noGhost)

  // ── B4: the "back to your notes" centroid pill (§14 G2) ───────────────────────
  // Escaped happy-dom: the pill (CentroidArrow, CanvasStage.tsx:1583-1664) was
  // gated on the INFLATED cull set, so a card was always "visible" and the pill
  // NEVER appeared. The fix gates it on `trueVisibleIds` (uninflated viewport,
  // CanvasStage.tsx:1493) → it renders iff cards exist AND zero are truly visible
  // (CanvasStage.tsx:1605 `if (placedLayouts.length === 0 || visibleIds.size > 0) return null`).
  // We drive it via the bridge (setCamera is the UNCLAMPED Dispatch). LAST in the
  // smoke because it pans the camera off the board — no position-sensitive
  // assertion follows. Selector: data-canvas-centroid-arrow (CanvasStage.tsx:1641).
  // The arrow glyph (one of → ↘ ↓ ↙ ← ↖ ↑ ↗) is the product's direction signal:
  // angle = atan2(centroid − viewportCenter) in WORLD coords (CanvasStage.tsx:1611-1627),
  // rendered as TEXT in the button (CanvasStage.tsx:1660) — no data-angle attr.
  const harnessLive = await win.evaluate(() => Boolean(window.__canvasHarness))
  if (!harnessLive) {
    assert('B4: harness bridge present to drive the camera', false)
  } else {
    // (a) ABSENT when centered on the board — the core B4 regression was that the
    // pill never appeared; the inverse anchor proves the gate is two-sided. The
    // seeded board spans ~5000×3300 with a uniform scatter, so its centroid ≈ the
    // world center; centering there keeps cards truly visible → pill hidden.
    await win.evaluate(
      ([world]) => {
        const w = window.innerWidth
        const h = window.innerHeight
        // Top-left-anchored camera (camera.ts): center the world center in view.
        window.__canvasHarness?.setCamera({
          x: world.w / 2 - w / 2,
          y: world.h / 2 - h / 2,
          zoom: 1,
        })
      },
      [WORLD],
    )
    await win.waitForTimeout(300)
    const pillCentered = await win.locator('[data-canvas-centroid-arrow]').count()
    assert('B4 centroid pill ABSENT when centered on the board', pillCentered === 0)

    // (b) PRESENT when panned FAR into empty world space (x = -8000, well left of
    // the [0,5000] board → zero cards truly visible). The pill must appear (the
    // regression: it never did). Keeping y near the board centroid makes the
    // viewport→centroid vector point almost due RIGHT, so the glyph must be `→`.
    await win.evaluate(
      ([world]) => {
        const h = window.innerHeight
        // y so the viewport center ≈ board centroid_y (world.h/2) → near-horizontal
        // vector; x far left so dx ≫ |dy| → unambiguous → octant.
        window.__canvasHarness?.setCamera({ x: -8000, y: world.h / 2 - h / 2, zoom: 1 })
      },
      [WORLD],
    )
    await win.waitForTimeout(300)
    const pillBtn = win.locator('[data-canvas-centroid-arrow]')
    const pillPanned = await pillBtn.count()
    assert(
      'B4 centroid pill APPEARS when panned to empty space (trueVisibleIds gate)',
      pillPanned > 0,
    )
    if (pillPanned > 0) {
      // Direction: read the rendered glyph (the product's only direction signal).
      // Panned far LEFT of the board, the centroid is to the RIGHT → expect `→`.
      // The dx (~+10000) so dominates |dy| (≲ centroid_y span) that only the `→`
      // octant ([-22.5°,22.5°)) is reachable — a stable, non-brittle check.
      const glyph = await pillBtn.evaluate((el) => (el.textContent || '').trim().charAt(0))
      console.log(`centroid pill glyph (panned far-left): "${glyph}" (expect →)`)
      assert(
        'B4 centroid arrow points toward the note centroid (→ when panned left)',
        glyph === '→',
      )
    }
    // Restore a board-centered view so the run ends on a sane camera.
    await win.evaluate(
      ([world]) => {
        const w = window.innerWidth
        const h = window.innerHeight
        window.__canvasHarness?.setCamera({
          x: world.w / 2 - w / 2,
          y: world.h / 2 - h / 2,
          zoom: 1,
        })
      },
      [WORLD],
    )
  }

  // ── EDGE PATHS (v0.4.1 §8 harness tier — pointer-driven, happy-dom-untestable) ──
  // ctrl-drag card→card → createEdge; drag-into-empty → EdgeTargetPicker create+
  // connect; select-click + ⌫ deletes a drawn edge; a 'reference' edge is NOT
  // deletable. Read the edge COUNT through the app's OWN read path (canvas:edges,
  // Task 1) — the SAME query the underlay renders from — so the assertion measures
  // the persisted rows, not the DOM. Canvas/arrangement keys are the §2 opaque
  // values (ROOT_CANVAS_ID='root' / MANUAL_ARRANGEMENT_ID='manual', src/shared/
  // canvas.ts) — the same pair seedViaIpc + createNoteAt use above.
  const edgeCount = () =>
    win.evaluate(() =>
      window.api.canvas.edges({ canvasId: 'root', arrangementId: 'manual' }).then((e) => e.length),
    )

  // Restore a board-centered camera (B4 left it there too, but be explicit) and
  // clear any selection so the edge sub-tests start clean.
  await win.evaluate(
    ([world]) => {
      const w = window.innerWidth
      const h = window.innerHeight
      window.__canvasHarness?.setCamera({
        x: world.w / 2 - w / 2,
        y: world.h / 2 - h / 2,
        zoom: 1,
      })
    },
    [WORLD],
  )
  await win.keyboard.press('Escape')
  await win.waitForTimeout(200)

  // ── ctrl-drag card→card creates a drawn edge (§3) ─────────────────────────────
  // Two fully-visible cards at distinct probe points. The product selects the
  // TOPMOST card under each press, but for edge creation we don't read selection
  // back — the gesture routes by hitVisibleAt(dropWorld) at mouse.up, which lands
  // the edge on whatever card the cursor is over (the dst probe). We keep the two
  // on-screen CENTERS to (a) drive the drag and (b) compute the screen midpoint
  // the select/delete sub-test clicks. ctrl is held across down→move→up so the
  // gesture is the edge-draw, not a move (decision 2: ctrl-drag = edge).
  let srcCenter = null
  let dstCenter = null
  const srcCard = await pickCardNear(win, vp.x + vp.width * 0.32, vp.y + vp.height * 0.4)
  const dstCard = await pickCardNear(win, vp.x + vp.width * 0.68, vp.y + vp.height * 0.62)
  if (!srcCard || !dstCard || srcCard.id === dstCard.id) {
    assert('edge ctrl-drag: two distinct fully-visible cards to connect', false)
  } else {
    srcCenter = { x: srcCard.x + srcCard.w / 2, y: srcCard.y + srcCard.h / 2 }
    dstCenter = { x: dstCard.x + dstCard.w / 2, y: dstCard.y + dstCard.h / 2 }
    const before = await edgeCount()
    await win.mouse.move(srcCenter.x, srcCenter.y)
    await win.keyboard.down('Control')
    await win.mouse.down()
    // Step the rubber-band to the dst center so the live drag crosses real frames
    // (the gesture machine runs on native pointermove + setPointerCapture).
    for (let i = 1; i <= 6; i++) {
      await win.mouse.move(
        srcCenter.x + ((dstCenter.x - srcCenter.x) * i) / 6,
        srcCenter.y + ((dstCenter.y - srcCenter.y) * i) / 6,
      )
    }
    await win.mouse.up()
    await win.keyboard.up('Control')
    await win.waitForTimeout(500) // createEdge txn + invalidate + edges refetch
    const after = await edgeCount()
    console.log(`edges before/after ctrl-drag: ${before} → ${after}`)
    assert('edge ctrl-drag card→card created an edge (count +1, §3)', after === before + 1)
  }
  await win.keyboard.press('Escape')
  await win.waitForTimeout(150)

  // ── drag-into-empty opens the target picker + creates+connects (§4) ───────────
  // ctrl-drag from a card to a product-classified EMPTY point → on drop (no card
  // under the cursor) the §4 EdgeTargetPicker opens at the drop point. Type a
  // query that matches NO seeded title (titles are "Seed note N"; "zqx…" has no
  // subsequence in any) so the ONLY row is the trailing "create" row → it is the
  // highlighted Command.Item → Enter routes onCreateAndConnect: createNoteAt at the
  // drop point THEN createEdge to the new note. Asserts BOTH a new card and a new
  // edge appeared (place + connect in one gesture).
  const pickerSrc = await pickCardNear(win, vp.x + vp.width * 0.4, vp.y + vp.height * 0.4)
  const emptyDrop = await findEmptyPoint(win, vp)
  if (!pickerSrc || !emptyDrop) {
    assert('edge drag-into-empty: a source card + an empty drop point', false)
  } else {
    const psc = { x: pickerSrc.x + pickerSrc.w / 2, y: pickerSrc.y + pickerSrc.h / 2 }
    const beforeEdges = await edgeCount()
    const beforeCards = await win.locator('[data-note-id]').count()
    await win.mouse.move(psc.x, psc.y)
    await win.keyboard.down('Control')
    await win.mouse.down()
    for (let i = 1; i <= 6; i++) {
      await win.mouse.move(
        psc.x + ((emptyDrop.x - psc.x) * i) / 6,
        psc.y + ((emptyDrop.y - psc.y) * i) / 6,
      )
    }
    await win.mouse.up()
    await win.keyboard.up('Control')
    await win.waitForTimeout(250)
    const pickerOpen = await win.evaluate(
      () => !!document.querySelector('[data-edge-target-picker]'),
    )
    assert('edge drag-into-empty opened the target picker ([data-edge-target-picker])', pickerOpen)
    if (pickerOpen) {
      // The picker input auto-focuses on mount; type a no-match query so only the
      // "create" row exists, then Enter commits create+connect.
      await win.keyboard.type('zqxedgesmoke')
      await win.waitForTimeout(150)
      await win.keyboard.press('Enter')
      await win.waitForTimeout(600) // createNoteAt + createEdge + invalidate + refetch
      const afterEdges = await edgeCount()
      const afterCards = await win.locator('[data-note-id]').count()
      console.log(
        `edges ${beforeEdges}→${afterEdges} · cards ${beforeCards}→${afterCards} (create+connect)`,
      )
      assert(
        'edge drag-into-empty created a new note (count +1, §4)',
        afterCards === beforeCards + 1,
      )
      assert(
        'edge drag-into-empty connected it (edge count +1, §4)',
        afterEdges === beforeEdges + 1,
      )
    }
  }
  await win.keyboard.press('Escape')
  await win.waitForTimeout(150)

  // ── select + ⌫ deletes a drawn edge (§5) ──────────────────────────────────────
  // The ctrl-drag edge (sub-test 1) is a center-to-center segment between two known
  // card centers. We click a point ON that segment with NO card under it so
  // onWorldPointerDown's card-precedence branch (hitVisibleAt !== null,
  // CanvasStage.tsx:1281) is NOT taken and it falls through to hitEdgeAt →
  // setSelectedEdge (:1290). The raw midpoint sits near viewport-center — the
  // densest region of the deterministic 500-card seed — so a THIRD card usually
  // covers it; a plain click there would select that CARD, and an unconditional
  // ⌫ would then route to onRemove() and DELETE the card (corrupting sub-test 4).
  // So we (a) sample several fractions along the segment, (b) accept a candidate
  // ONLY when the click selects the EDGE ([data-edge-selected] present AND
  // selectedCardId null), Escaping (never ⌫) past any candidate that grabbed a
  // card, and (c) gate ⌫ on a confirmed edge selection — the card-delete path is
  // impossible. If no candidate selects the edge → honest skip (no deletion).
  if (!srcCenter || !dstCenter) {
    assert('edge select: a drawn edge from the ctrl-drag sub-test to select', false)
  } else {
    let edgePicked = false
    for (const f of [0.5, 0.4, 0.6, 0.35, 0.65]) {
      const p = {
        x: srcCenter.x + (dstCenter.x - srcCenter.x) * f,
        y: srcCenter.y + (dstCenter.y - srcCenter.y) * f,
      }
      await win.mouse.move(p.x, p.y)
      await win.mouse.down()
      await win.mouse.up()
      await win.waitForTimeout(120)
      const edgeSel = await win.evaluate(() =>
        document.querySelector('[data-canvas-world]')?.hasAttribute('data-edge-selected'),
      )
      // The edge is selected only if the marker is present AND no card is ringed
      // (selectedCardId null) — a card click sets the ring, not the edge marker,
      // but assert the conjunction defensively before allowing ⌫.
      const cardSel = await selectedCardId(win)
      if (edgeSel === true && cardSel === null) {
        edgePicked = true
        break
      }
      // A card (or nothing) got picked — clear WITHOUT ⌫ so no card is deleted.
      await win.keyboard.press('Escape')
      await win.waitForTimeout(80)
    }
    assert('edge click selected the drawn edge ([data-edge-selected], not a card §5)', edgePicked)
    if (edgePicked) {
      const before = await edgeCount()
      await win.keyboard.press('Backspace') // safe: an EDGE is confirmed selected
      await win.waitForTimeout(500) // deleteEdge txn + invalidate + edges refetch
      const after = await edgeCount()
      console.log(`edges before/after select+⌫: ${before} → ${after}`)
      assert('edge ⌫ deleted the selected drawn edge (count −1, §5)', after === before - 1)
    } else {
      // No on-segment point selected the edge (dense board covered them all). Do
      // NOT ⌫ — sub-test 4 must see an uncorrupted board. The select assert above
      // already records the miss honestly.
      console.log('edge select: no card-free point on the segment selected the edge — skipping ⌫')
    }
  }
  await win.keyboard.press('Escape')
  await win.waitForTimeout(150)

  // ── a 'reference' edge is NOT deletable (§5 decision 6) ────────────────────────
  // The seed makes note 1's body wikilink [[Seed note 0]] → a resolvable 'reference'
  // links row (1 → 0). Locate it via the app's read path, fit the camera to BOTH
  // endpoints (random scatter → use listLayouts for their world rects), wait for
  // both cards to mount, click the screen midpoint. A reference edge is non-drawn,
  // so nearestDrawnEdge skips it (edge-geometry.ts:104) → no selection, and ⌫ is a
  // no-op → edge count UNCHANGED.
  const refEdge = await win.evaluate(() =>
    window.api.canvas
      .edges({ canvasId: 'root', arrangementId: 'manual' })
      .then((es) => es.find((e) => e.edgeType === 'reference') ?? null),
  )
  if (!refEdge) {
    assert('reference edge: a rendered reference edge exists (seed [[Seed note 0]])', false)
  } else {
    // Fit the camera to the two endpoints (mirror fitCamera: center + zoom). The
    // bridge setCamera is the UNCLAMPED Dispatch, so a zoom < 0.5 is honored when
    // the two random endpoints are far apart (keeps both on-screen).
    await win.evaluate(
      ([ids, cardW, cardH]) => {
        const w = window.innerWidth
        const h = window.innerHeight
        return window.api.canvas
          .listLayouts({ canvasId: 'root', arrangementId: 'manual' })
          .then((rows) => {
            const wanted = rows.filter((r) => ids.includes(r.note_id) && r.x !== null)
            if (wanted.length < 2) return
            let minX = Number.POSITIVE_INFINITY
            let minY = Number.POSITIVE_INFINITY
            let maxX = Number.NEGATIVE_INFINITY
            let maxY = Number.NEGATIVE_INFINITY
            for (const r of wanted) {
              minX = Math.min(minX, r.x)
              minY = Math.min(minY, r.y)
              maxX = Math.max(maxX, r.x + cardW)
              maxY = Math.max(maxY, r.y + cardH)
            }
            const pad = 120
            // Floor at 0.16 (just above the dot-tier threshold 0.15, lod.ts:10) so
            // BOTH cards stay mounted as DOM ([data-note-id]) — at the dot tier the
            // whole card layer is dropped (CanvasStage.tsx:1566) and the click would
            // have no rects to land on. Cap at 1 so a near pair doesn't over-zoom.
            const zoom = Math.max(
              0.16,
              Math.min(
                (w - 2 * pad) / Math.max(1, maxX - minX),
                (h - 2 * pad) / Math.max(1, maxY - minY),
                1,
              ),
            )
            const cx = (minX + maxX) / 2
            const cy = (minY + maxY) / 2
            window.__canvasHarness?.setCamera({ x: cx - w / zoom / 2, y: cy - h / zoom / 2, zoom })
          })
      },
      [[refEdge.fromNoteId, refEdge.toNoteId], CARD_W, CARD_H],
    )
    await win.waitForTimeout(400) // camera write + cull pass + card mount
    const rects = await win.evaluate(
      ([from, to]) => {
        const r = (id) => {
          const el = document.querySelector(`[data-note-id="${id}"]`)
          if (!el) return null
          const b = el.getBoundingClientRect()
          return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
        }
        return { from: r(from), to: r(to) }
      },
      [refEdge.fromNoteId, refEdge.toNoteId],
    )
    if (!rects.from || !rects.to) {
      assert('reference edge: both endpoints mounted on-screen after fit', false)
    } else {
      const before = await edgeCount()
      const mid = {
        x: (rects.from.x + rects.to.x) / 2,
        y: (rects.from.y + rects.to.y) / 2,
      }
      await win.mouse.move(mid.x, mid.y)
      await win.mouse.down()
      await win.mouse.up()
      await win.waitForTimeout(150)
      const selected = await win.evaluate(() =>
        document.querySelector('[data-canvas-world]')?.hasAttribute('data-edge-selected'),
      )
      assert('reference edge does NOT select on click ([data-edge-selected] absent §5)', !selected)
      await win.keyboard.press('Backspace')
      await win.waitForTimeout(400)
      const after = await edgeCount()
      console.log(`edges before/after reference ⌫: ${before} → ${after} (expect unchanged)`)
      assert('reference edge is NOT deletable (count unchanged §5 decision 6)', after === before)
    }
  }

  const failures = out.filter(([, ok]) => !ok)
  console.log('')
  console.log(
    failures.length === 0
      ? `SMOKE VERDICT: PASS — all ${out.length} assertions OK (#119 #121 #111 B3-deselect B4-centroid edge-create/connect/select/delete covered)`
      : `SMOKE VERDICT: FAIL — ${failures.length}/${out.length} assertions failed: ` +
          failures.map(([l]) => l).join(' · '),
  )
  return failures.length === 0 ? 0 : 1
}

// react-hotkeys-hook `mod` = Meta on macOS, Control elsewhere (App binds `mod+2`);
// Playwright sends the literal key, so pick the modifier per platform or the
// shortcut silently no-ops on the (Linux) reference hardware.
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'
// --smoke flips this whole runner from the perf GATES to the pointer SMOKE flow
// (Task 3). The shared setup (launch + guards + seed + reload + switch-to-canvas +
// board-non-empty) runs for BOTH; only the post-setup body branches. The default
// `pnpm harness:canvas` (no flag) behaves EXACTLY as before.
const SMOKE = process.argv.includes('--smoke')
const userDataDir = mkdtempSync(join(tmpdir(), 'linsae-perf-harness-'))

const app = await electron.launch({
  // Anti-throttling switches (harness-only — passed to THIS launch, never to the
  // shipped app). Chromium throttles requestAnimationFrame to ~1Hz for a window it
  // considers hidden/occluded/backgrounded; on a real desktop the launched window
  // can lose foreground after reload and the phase rAF clock would then sample ~1
  // fps (meaningless). These keep the renderer + rAF at full rate regardless of
  // focus/occlusion, so the gate measures RENDER cost, not OS window state.
  args: [
    'out/main/index.js',
    `--user-data-dir=${userDataDir}`,
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
  ],
  env: { ...process.env, LINSAE_HARNESS: '1' },
})
let exitCode = 0
try {
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')

  // ---- Defeat rAF throttling (the Electron-native way). A window Chromium deems
  // hidden/backgrounded throttles requestAnimationFrame to ~1Hz, which would make
  // the phase frame-clock sample ~1 fps of garbage. setBackgroundThrottling(false)
  // keeps animations + timers at full rate regardless of window state. Called from
  // the MAIN process on every BrowserWindow (harness-only; never ships).
  await app.evaluate(({ BrowserWindow }) => {
    for (const w of BrowserWindow.getAllWindows()) w.webContents.setBackgroundThrottling(false)
  })

  // ---- GPU guard: VERBATIM logic from spike run.mjs:16-45 (poll until populated).
  let gpu = {}
  for (let i = 0; i < 20 && !gpu.gpu_compositing; i++) {
    gpu = await app.evaluate(({ app: a }) => a.getGPUFeatureStatus())
    if (!gpu.gpu_compositing) await new Promise((r) => setTimeout(r, 100))
  }
  const gpuInfo = await app.evaluate(({ app: a }) => a.getGPUInfo('complete'))
  const glRenderer =
    gpuInfo?.auxAttributes?.glRenderer ||
    [
      gpuInfo?.gpuDevice?.[0]?.driverVendor,
      gpuInfo?.gpuDevice?.[0]?.driverVersion,
      gpuInfo?.auxAttributes?.glImplementationParts,
    ]
      .filter(Boolean)
      .join(' ') ||
    'unknown'
  console.log(
    `gpu_compositing=${gpu.gpu_compositing} gl="${glRenderer}" session=${process.env.XDG_SESSION_TYPE}`,
  )
  if (!/enabled/.test(gpu.gpu_compositing || '') || /llvmpipe|swiftshader/i.test(glRenderer)) {
    throw new AbortError('GPU compositing not hardware-accelerated — results invalid (xvfb/ssh?).')
  }

  // ---- vsync probe: VERBATIM from spike run.mjs:53-72 (61 rAF frames → median).
  const vsync = await win.evaluate(
    () =>
      new Promise((resolve) => {
        const ts = []
        const tick = (now) => {
          ts.push(now)
          if (ts.length >= 61) {
            const ints = ts
              .slice(1)
              .map((t, i) => t - ts[i])
              .sort((a, b) => a - b)
            resolve(+ints[Math.floor(ints.length / 2)].toFixed(2))
          } else {
            requestAnimationFrame(tick)
          }
        }
        requestAnimationFrame(tick)
      }),
  )
  console.log(`vsync p50 ≈ ${vsync}ms`)
  // Pinned-protocol trap: a non-60Hz/throttled display makes "p95 ≤ 18ms" mean
  // something else. Abort outside 15–18ms (the 60Hz band).
  if (vsync < 15 || vsync > 18) {
    throw new AbortError(
      `vsync p50 ${vsync}ms outside 15–18ms — display not at 60Hz / awake. Aborting.`,
    )
  }

  // ---- SEED via createNoteAt IPC, then RELOAD so the canvas re-reads the rows.
  const seeded = await seedViaIpc(win)
  console.log(`seeded ${seeded} notes via createNoteAt IPC`)
  await win.reload()
  await win.waitForLoadState('domcontentloaded')

  // ---- switch to canvas + wait for the world to mount.
  await win.keyboard.press(`${MOD}+2`)
  await win.locator('[data-canvas-viewport]').waitFor({ state: 'visible', timeout: 8000 })
  // The world div is a 0-size transform container (position:absolute, no w/h —
  // its children are absolutely positioned), so Playwright never deems it
  // 'visible'; 'attached' is the correct mount signal (it renders under
  // `ready &&`). The board-non-empty card-count guard below is the real check.
  await win.locator('[data-canvas-world]').waitFor({ state: 'attached', timeout: 8000 })
  // Bring the window foreground so it is not occluded when measuring (belt-and-
  // suspenders with the anti-throttling launch switches): an occluded/unfocused
  // window throttles rAF to ~1Hz and the phase clock would sample garbage.
  await win.bringToFront()
  await win.waitForTimeout(800) // let the first cull pass + fonts settle

  // ---- BOARD-NON-EMPTY GUARD (B1 safety net): the gate must never measure an
  // empty board. Culling mounts only intersecting cards, so check a sane floor.
  const cardCount = await win.locator('[data-note-id]').count()
  console.log(`mounted cards in viewport: ${cardCount} (floor ${MIN_CARDS})`)
  if (cardCount < MIN_CARDS) {
    throw new AbortError(
      `only ${cardCount} cards mounted after seed+reload — board empty/near-empty ` +
        `(seeding or reconcile failed?). Aborting before measuring.`,
    )
  }

  // Diagnostic: a hidden page throttles rAF to ~1Hz. If this prints
  // visibility=hidden the frame clock is invalid (see setBackgroundThrottling).
  const vis = await win.evaluate(() => ({
    state: document.visibilityState,
    hidden: document.hidden,
    focus: document.hasFocus(),
  }))
  console.log(`page visibility=${vis.state} hidden=${vis.hidden} hasFocus=${vis.focus}`)

  // ---- BRANCH: --smoke runs the pointer smoke flow (Task 3) instead of the perf
  // gates. The default path (no flag) is the unchanged 3-phase / 3-run verdict.
  if (SMOKE) {
    exitCode = await runSmoke(win)
  } else {
    // ---- run the three phases, 3× each, take the median by mean fps.
    const results = {}
    for (const phase of ['churn', 'steady', 'dot']) {
      if (phase === 'dot') {
        await win.evaluate(() =>
          window.__canvasHarness?.setDevLod({
            forceTier: 'dot',
            syntheticDots: true,
            unclampZoom: true,
          }),
        )
        await win.waitForTimeout(300) // let cards unmount + the dot layer draw
        // Post-condition (Task-2 review): prove the tier actually FLIPPED before
        // measuring it. forceTier:'dot' unmounts every card, so the dot gate is
        // valid only if zero cards remain; otherwise setDevLod silently no-op'd
        // (e.g. the bridge was gone) and we'd be measuring the card tier under a
        // 'dot' label — a silent wrong measurement. Abort rather than mis-report.
        const dotCards = await win.locator('[data-note-id]').count()
        console.log(`dot-tier card count: ${dotCards} (expect 0 — cards unmount at dot tier)`)
        if (dotCards > 0) {
          throw new AbortError(
            `${dotCards} cards still mounted after forcing dot tier — tier did NOT ` +
              `flip, so the dot gate would measure the card tier. Aborting.`,
          )
        }
        // Zoom FAR + center on the synthetic dot field so ~all 10k dots are
        // on-screen — without this the dot phase oscillates at the zoom-1 camera
        // inherited from the steady phase, where the 10k dots (spread over
        // DOT_SPREAD world px) put only ~1 dot on-canvas and the gate is hollow
        // (#124). The camera is top-left-anchored (camera.ts), so centering the
        // [0,DOT_SPREAD]² field needs cam = field-center − half-viewport-in-world.
        // unclampZoom is already on (set above), so zoom 0.1 is written verbatim.
        // runPhase reads this back as `base` and oscillates ±60 world px about it.
        await win.evaluate(
          ([spread, zoom]) => {
            const w = window.innerWidth
            const h = window.innerHeight
            window.__canvasHarness?.setCamera({
              x: spread / 2 - w / 2 / zoom,
              y: spread / 2 - h / 2 / zoom,
              zoom,
            })
          },
          [DOT_SPREAD, DOT_ZOOM],
        )
        await win.waitForTimeout(300) // let the far-zoom underlay redraw settle
      }
      const runs = []
      for (let r = 0; r < RUNS; r++) {
        const run = await runPhase(win, phase, PHASE_MS)
        // Mid-run rAF-throttle tripwire (#126): a ~1Hz throttle (DPMS-blank) pushes
        // the MEDIAN frame interval to ~1000ms. Abort with the cause, not a bogus
        // "suspect React reconcile" verdict that sends the operator chasing a ghost.
        if (run.p50 > THROTTLE_P50_MS) {
          throw new AbortError(
            `display throttled mid-run (phase=${phase} run=${r} p50=${run.p50}ms ` +
              `≈ ${(1000 / run.p50).toFixed(1)}fps) — the screen likely DPMS-blanked, which ` +
              `throttles rAF to ~1Hz and is NOT a render regression. Re-run with the display ` +
              `kept awake: xset -dpms s off (restore after). See docs/harness/canvas-perf.md + issue #126.`,
          )
        }
        runs.push(run)
        await win.waitForTimeout(300)
      }
      results[phase] = { median: medianByMeanFps(runs), runs }
      if (phase === 'dot') {
        await win.evaluate(() =>
          window.__canvasHarness?.setDevLod({
            forceTier: 'auto',
            syntheticDots: false,
            unclampZoom: false,
          }),
        )
      }
    }

    // ---- verdict table + gate judging.
    console.log('\n| phase | meanFps | p50 | p95 | p99 | max | >17ms | >100ms |')
    console.log('|---|---|---|---|---|---|---|---|')
    for (const phase of ['churn', 'steady', 'dot']) {
      const m = results[phase].median
      console.log(
        `| ${phase} | ${m.meanFps} | ${m.p50} | ${m.p95} | ${m.p99} | ${m.max} | ${m.over17}/${m.frames} | ${m.over100} |`,
      )
    }
    const c = results.churn.median
    const s = results.steady.median
    const d = results.dot.median
    const checks = [
      ['churn meanFps ≥ 55', c.meanFps >= GATES.churn.meanFps],
      ['churn p95 ≤ 33.4', c.p95 <= GATES.churn.p95],
      ['churn zero >100ms', c.over100 === GATES.churn.over100],
      ['steady p95 ≤ 18', s.p95 <= GATES.steady.p95],
      ['dot p95 ≤ 18', d.p95 <= GATES.dot.p95],
    ]
    console.log('')
    for (const [label, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`)
    const pass = checks.every(([, ok]) => ok)
    console.log(
      pass
        ? '\nVERDICT: PASS — §3 gates met on the median run'
        : '\nVERDICT: FAIL — below a §3 gate; suspect React reconcile first (profile; React Compiler is on)',
    )
    exitCode = pass ? 0 : 1
  }
} catch (err) {
  // Expected operator-facing aborts (AbortError) print just the message — a stack
  // is noise for "your display went to sleep". Unexpected bugs still print the stack.
  console.error(
    err.expected ? `HARNESS ABORT: ${err.message}` : `HARNESS ERROR: ${err.stack || err.message}`,
  )
  exitCode = 1
} finally {
  await app.close()
  rmSync(userDataDir, { recursive: true, force: true })
}
process.exit(exitCode)
