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
//   dot    — forceTier:'dot' + 10k synthetic dots + unclamp zoom, oscillate:
//            gate p95 ≤ 18ms.
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

// ---- §3 gates (exact). churn vs steady vs dot, each judged on the median run.
const GATES = {
  churn: { meanFps: 55, p95: 33.4, over100: 0 },
  steady: { p95: 18 },
  dot: { p95: 18 },
}
const SEED = 42
const COUNT = 500
const WORLD = { w: 5000, h: 3300 }
const CARD_W = 360 // CanvasStage CARD_WIDTH
const CARD_H = 140 // CanvasStage DEFAULT_CARD_HEIGHT
const RUNS = 3
const PHASE_MS = 8000 // per-phase choreography duration
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
        const body =
          `# Seed note ${i}\n\nProse with **emphasis** and a [[wikilink]], long enough ` +
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
// cam (the runner forces the dot tier before the 'dot' phase). setCamera is the
// UNCLAMPED Dispatch (clamping lives only in the gesture helpers, which the bridge
// never touches), so {x,y,zoom} are written verbatim. Runs entirely in the page so
// the rAF clock and the setCamera writes share a frame (the spike's runChoreo).
async function runPhase(win, mode, durationMs) {
  return win.evaluate(
    async ([m, dur, statsSrc, world]) => {
      // biome-ignore lint: injected stats() (spike-verbatim)
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
  const card = await pickCardNear(win, probe.x, probe.y)
  if (!card) {
    assert('drag: a fully-visible card to grab', false)
    return out.filter(([, ok]) => !ok).length > 0 ? 1 : 0
  }
  const startC = { x: card.x + card.w / 2, y: card.y + card.h / 2 }
  const DELTA = { x: 220, y: -140 } // enough to clear the §8 drag threshold + be visible
  await win.mouse.move(startC.x, startC.y)
  await win.mouse.down()
  // A few steps so the move is a real drag, not a teleport (matches send-harness).
  for (let i = 1; i <= 5; i++) {
    await win.mouse.move(startC.x + (DELTA.x * i) / 5, startC.y + (DELTA.y * i) / 5)
  }
  await win.mouse.up()
  // #119: sample the card's rect across the frames right after mouse.up. If the
  // commit invalidation flashes, the card snaps back toward its ORIGIN (card.x)
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
    [card.id, 12],
  )
  console.log('drag x-trajectory (px):', JSON.stringify(flash)) // like send-harness `top trajectory`
  await win.waitForTimeout(400) // let the commit settle
  const settled = await noteRect(win, card.id)
  const movedX = settled ? settled.x - card.x : 0
  const movedY = settled ? settled.y - card.y : 0
  // Allow generous tolerance: the drag delta is in SCREEN px at zoom 1, so the card
  // should land ≈DELTA away. Half-delta floor proves it moved and STAYED moved.
  assert(
    'drag-to-move commit: card landed ≈ drag delta and stayed (§8)',
    settled !== null && Math.abs(movedX - DELTA.x) < 80 && Math.abs(movedY - DELTA.y) < 80,
  )
  // #119: the origin is card.x. A flash is any sampled frame whose x is back near
  // the origin (within 40px) while the settled position is far from it (the card
  // genuinely moved). If it never moved we skip (movedX≈0 ⇒ no meaningful origin).
  const originX = card.x
  const reallyMoved = Math.abs(movedX) > 80
  const flashed = reallyMoved && flash.some((x) => x !== null && Math.abs(x - originX) < 40)
  assert('#119 no drag-commit flash: card never snapped back to origin post-up', !flashed)

  // ── Marquee select (§8): rubber-band ≥2 cards → ≥2 selection rings ────────────
  // Find an empty surface point (no card under it) inside the viewport to start the
  // marquee, then drag a wide rect. Scan a coarse grid for an empty spot.
  const emptyPt = await win.evaluate(() => {
    const vpEl = document.querySelector('[data-canvas-viewport]')
    if (!vpEl) return null
    const v = vpEl.getBoundingClientRect()
    for (let gy = 0.2; gy <= 0.8; gy += 0.1) {
      for (let gx = 0.2; gx <= 0.8; gx += 0.1) {
        const px = v.left + v.width * gx
        const py = v.top + v.height * gy
        const top = document.elementFromPoint(px, py)
        // empty iff the topmost element is not inside any card shell
        if (top && !top.closest('[data-note-id]')) return { x: px, y: py }
      }
    }
    return null
  })
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

  // ── #121: double-click OVER a card edits, does NOT create ─────────────────────
  const beforeEdit = await win.locator('[data-note-id]').count()
  const editCard = await pickCardNear(win, probe.x, probe.y)
  if (!editCard) {
    assert('#121: a fully-visible card to double-click', false)
  } else {
    const ec = { x: editCard.x + editCard.w / 2, y: editCard.y + editCard.h / 2 }
    await win.mouse.dblclick(ec.x, ec.y)
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
  const createPt = await win.evaluate(() => {
    const vpEl = document.querySelector('[data-canvas-viewport]')
    if (!vpEl) return null
    const v = vpEl.getBoundingClientRect()
    for (let gy = 0.25; gy <= 0.75; gy += 0.1) {
      for (let gx = 0.25; gx <= 0.75; gx += 0.1) {
        const px = v.left + v.width * gx
        const py = v.top + v.height * gy
        const top = document.elementFromPoint(px, py)
        if (top && !top.closest('[data-note-id]')) return { x: px, y: py }
      }
    }
    return null
  })
  if (!createPt) {
    assert('placement: an empty point to double-click-create', false)
  } else {
    await win.mouse.dblclick(createPt.x, createPt.y)
    await win.locator('[data-canvas-create]').waitFor({ state: 'visible', timeout: 4000 })
    // The create composer's textarea (Composer.tsx) — type then Enter submits
    // (Composer onKeyDown: Enter without shift → onSubmit, Composer.tsx:163).
    const ta = win.locator('[data-canvas-create] textarea')
    await ta.click()
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

  const failures = out.filter(([, ok]) => !ok)
  console.log('')
  console.log(
    failures.length === 0
      ? `SMOKE VERDICT: PASS — all ${out.length} assertions OK (#119 #121 #111 covered)`
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
    console.error('FAIL: GPU compositing not hardware-accelerated — results invalid (xvfb/ssh?).')
    await app.close()
    process.exit(1)
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
    console.error(
      `FAIL: vsync p50 ${vsync}ms outside 15–18ms — display not at 60Hz / awake. Aborting.`,
    )
    await app.close()
    process.exit(1)
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
    console.error(
      `FAIL: only ${cardCount} cards mounted after seed+reload — board empty/near-empty ` +
        `(seeding or reconcile failed?). Aborting before measuring.`,
    )
    await app.close()
    process.exit(1)
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
          console.error(
            `FAIL: ${dotCards} cards still mounted after forcing dot tier — tier did NOT ` +
              `flip, so the dot gate would measure the card tier. Aborting.`,
          )
          await app.close()
          process.exit(1)
        }
      }
      const runs = []
      for (let r = 0; r < RUNS; r++) {
        runs.push(await runPhase(win, phase, PHASE_MS))
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
  console.error(`HARNESS ERROR: ${err.stack || err.message}`)
  exitCode = 1
} finally {
  await app.close()
  rmSync(userDataDir, { recursive: true, force: true })
}
process.exit(exitCode)
