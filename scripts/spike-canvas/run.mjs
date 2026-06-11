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
const glRenderer = info?.auxAttributes?.glRenderer || 'unknown'
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
console.log('scaffold OK')
await app.close()
