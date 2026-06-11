// Playwright-Electron runner for the canvas substrate spike (research §Stage 0).
// Run on the REAL display session — NEVER under xvfb/ssh: software GL invalidates results.
// Usage: pnpm spike:canvas          # benchmark matrix
//        pnpm spike:canvas --ink    # interactive ink-latency window (Task 4)
import { _electron as electron } from 'playwright'

const INK = process.argv.includes('--ink')
const app = await electron.launch({
  args: ['scripts/spike-canvas/main.mjs'],
  env: { ...process.env, SPIKE_MODE: INK ? 'ink' : 'bench' },
})
const win = await app.firstWindow()
await win.waitForLoadState('domcontentloaded')
// getGPUFeatureStatus is only usable after Electron's gpu-info-update event
// has fired (electronjs.org/docs/latest/api/app) — poll until populated.
let gpu = {}
for (let i = 0; i < 20 && !gpu.gpu_compositing; i++) {
  gpu = await app.evaluate(({ app: a }) => a.getGPUFeatureStatus())
  if (!gpu.gpu_compositing) await new Promise((r) => setTimeout(r, 100))
}
const info = await app.evaluate(({ app: a }) => a.getGPUInfo('complete'))
const glRenderer =
  info?.auxAttributes?.glRenderer ||
  [
    info?.gpuDevice?.[0]?.driverVendor,
    info?.gpuDevice?.[0]?.driverVersion,
    info?.auxAttributes?.glImplementationParts,
  ]
    .filter(Boolean)
    .join(' ') ||
  'unknown'
const env = await win.evaluate(() => ({
  dpr: devicePixelRatio,
  w: innerWidth,
  h: innerHeight,
}))
console.log(
  `gpu_compositing=${gpu.gpu_compositing} 2d_canvas=${gpu['2d_canvas']} gl="${glRenderer}" dpr=${env.dpr} viewport=${env.w}x${env.h} session=${process.env.XDG_SESSION_TYPE}`,
)
// llvmpipe/SwiftShader in the GL renderer string = software GL, the unambiguous tell.
if (!/enabled/.test(gpu.gpu_compositing || '') || /llvmpipe|swiftshader/i.test(glRenderer)) {
  console.error('FAIL: GPU compositing is not hardware-accelerated — results invalid (xvfb/ssh?).')
  await app.close()
  process.exit(1)
}
if (INK) {
  console.log('Ink window open — draw; d toggles desynchronized, c clears. Close window to exit.')
  await new Promise((resolve) => app.on('close', resolve))
  process.exit(0)
}
// Measured vsync on the idle page: thresholds below assume ~16.7ms (60Hz).
// On a 75/120Hz panel "p95 ≤ 18ms" means something else — record and interpret.
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

const MATRIX = [
  ['cards', { mode: 'none' }],
  ['cards', { mode: 'cull' }],
  ['cards', { mode: 'cv-all' }],
  ['cards', { mode: 'cull+cv' }],
  ['dots', { dprCap: false }],
  ['dots', { dprCap: true }],
]

const rows = []
for (const [name, opts] of MATRIX) {
  const st = await win.evaluate(([n, o]) => window.Spike.scenarios[n](o), [name, opts])
  rows.push({ scenario: `${name} ${JSON.stringify(opts)}`, ...st })
  console.log(JSON.stringify(rows[rows.length - 1]))
}

console.log('\n| scenario | meanFps | p50 | p95 | p99 | max | >17ms | >100ms |')
console.log('|---|---|---|---|---|---|---|---|')
for (const r of rows) {
  console.log(
    `| ${r.scenario} | ${r.meanFps} | ${r.p50} | ${r.p95} | ${r.p99} | ${r.max} | ${r.over17}/${r.frames} | ${r.over100} |`,
  )
}

// 'none' is the diagnostic baseline (the Obsidian repro) — it may fail without
// failing the spike; only mitigated scenarios gate the verdict.
const gated = rows.filter((r) => !r.scenario.includes('"none"'))
const pass = gated.every((r) => r.meanFps >= 55 && r.p95 <= 18 && r.over100 === 0)
console.log(
  pass
    ? 'VERDICT: PASS — 60fps go/no-go met on all mitigated scenarios'
    : 'VERDICT: CHECK — below threshold somewhere; map to research §Benchmarks/thresholds',
)
await app.close()
