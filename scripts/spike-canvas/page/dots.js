// Dot-tier benchmark: 10k dots drawn each frame from a Float32Array on a
// canvas-2D layer (research §Stage 0; WebGL is the escalation if this misses
// 60fps, not part of the spike). dprCap=true renders the backing store at
// DPR 1 — the map-engine trick for fractional-scaling machines (research
// update, Tier 1 item 5).
;(() => {
  const S = window.Spike
  const N = 10000
  const canvas = document.getElementById('dots')

  S.scenarios.dots = async ({ dprCap }) => {
    S.world.style.display = 'none'
    canvas.style.display = 'block'
    const dpr = dprCap ? Math.min(1, devicePixelRatio) : devicePixelRatio
    const w = S.viewport.clientWidth
    const h = S.viewport.clientHeight
    canvas.width = Math.round(w * dpr)
    canvas.height = Math.round(h * dpr)
    const ctx = canvas.getContext('2d')

    const rand = S.mulberry32(7)
    const pos = new Float32Array(N * 2)
    for (let i = 0; i < N; i++) {
      pos[i * 2] = rand() * 10000
      pos[i * 2 + 1] = rand() * 6600
    }

    const draw = () => {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, w, h)
      ctx.fillStyle = '#3b6ea5'
      const { x, y, z } = S.cam
      for (let i = 0; i < N; i++) {
        const sx = (pos[i * 2] - x) * z + w / 2
        const sy = (pos[i * 2 + 1] - y) * z + h / 2
        if (sx < -2 || sy < -2 || sx > w + 2 || sy > h + 2) continue
        ctx.fillRect(sx - 1, sy - 1, 2, 2)
      }
    }

    const st = await S.runChoreo(
      { durationMs: 10000, panX: [4000, 6000], panY: [3000, 3600], baseZ: 0.1, zoomAmp: 0.5 },
      draw,
    )
    st.dpr = dpr
    return st
  }
})()
