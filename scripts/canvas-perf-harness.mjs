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

// react-hotkeys-hook `mod` = Meta on macOS, Control elsewhere (App binds `mod+2`);
// Playwright sends the literal key, so pick the modifier per platform or the
// shortcut silently no-ops on the (Linux) reference hardware.
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'
const userDataDir = mkdtempSync(join(tmpdir(), 'linsae-perf-harness-'))

const app = await electron.launch({
  args: ['out/main/index.js', `--user-data-dir=${userDataDir}`],
  env: { ...process.env, LINSAE_HARNESS: '1' },
})
let exitCode = 0
try {
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')

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
  await win.locator('[data-canvas-world]').waitFor({ state: 'visible', timeout: 8000 })
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
} catch (err) {
  console.error(`HARNESS ERROR: ${err.stack || err.message}`)
  exitCode = 1
} finally {
  await app.close()
  rmSync(userDataDir, { recursive: true, force: true })
}
process.exit(exitCode)
