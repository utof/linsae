// Shared camera + deterministic choreography + rAF frame recorder.
// Classic script (no modules): file:// module-script CORS is a trap; globals via window.Spike.
// Why: docs/research/2026-06-11-canvas-architecture-synthesis-v2.md §Stage 0 protocol.
window.Spike = (() => {
  const viewport = document.getElementById('viewport')
  const world = document.getElementById('world')
  const cam = { x: 0, y: 0, z: 1 }

  // screen = (world - cam) * z + viewport/2
  function applyCamera() {
    const tx = viewport.clientWidth / 2 - cam.x * cam.z
    const ty = viewport.clientHeight / 2 - cam.y * cam.z
    world.style.transform = `translate(${tx}px, ${ty}px) scale(${cam.z})`
  }

  // world-space rect currently visible, inflated by `margin` screen px
  function viewRect(margin) {
    const w = viewport.clientWidth / cam.z
    const h = viewport.clientHeight / cam.z
    const m = margin / cam.z
    return {
      minX: cam.x - w / 2 - m,
      minY: cam.y - h / 2 - m,
      maxX: cam.x + w / 2 + m,
      maxY: cam.y + h / 2 + m,
    }
  }

  // deterministic PRNG so card/dot layouts are identical across runs
  function mulberry32(seed) {
    let a = seed >>> 0
    return () => {
      a = (a + 0x6d2b79f5) | 0
      let t = Math.imul(a ^ (a >>> 15), 1 | a)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }

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
  }

  // Camera path is a pure function of elapsed time: first half = there-and-back
  // pan at baseZ, second half = zoom oscillation. Continuous (cosine) motion.
  function runChoreo(opts, onFrame) {
    const { durationMs, panX, panY, baseZ, zoomAmp } = opts
    return new Promise((resolve) => {
      const ts = []
      let start
      const tick = (now) => {
        if (start === undefined) start = now
        const t = (now - start) / durationMs
        if (t >= 1) {
          resolve(stats(ts))
          return
        }
        if (t < 0.5) {
          const u = t / 0.5
          cam.x = panX[0] + (panX[1] - panX[0]) * (0.5 - 0.5 * Math.cos(u * Math.PI * 2))
          cam.y = panY[0] + (panY[1] - panY[0]) * (0.5 - 0.5 * Math.cos(u * Math.PI))
          cam.z = baseZ
        } else {
          const u = (t - 0.5) / 0.5
          cam.z = baseZ * (1 - zoomAmp * (0.5 - 0.5 * Math.cos(u * Math.PI * 2)))
        }
        applyCamera()
        if (onFrame) onFrame()
        ts.push(now)
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
  }

  return { cam, viewport, world, applyCamera, viewRect, mulberry32, runChoreo, scenarios: {} }
})()
