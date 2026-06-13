// Card-tier benchmark: 500 absolutely-positioned DOM cards (title, prose,
// real KaTeX span, list) under four strategies:
//   'none'    — all 500 mounted, no mitigation: the raw DOM floor + Obsidian repro
//   'cull'    — mount only viewport-intersecting cards (linear AABB scan; rbush stand-in)
//   'cv-all'  — mount all 500 once, content-visibility:auto does the skipping
//   'cull+cv' — both
// Why: research §Stage 0 go/no-go (60fps pan/zoom at 500 cards) + §1 Tier-1
// content-visibility item. World sized so culled modes sustain ~110 in-rect
// cards at z=1 and ~265 at the zoom trough (measured, seed 42) — inside/above the Obsidian
// 40–200-card lag band the research cites. Cards are built once and cached;
// enter/exit churn measured here is append/remove + layout/paint (the
// Obsidian failure mode), not re-render. Vanilla DOM = substrate floor;
// React overhead is additive.
;(() => {
  const S = window.Spike
  const COUNT = 500
  const WORLD_W = 5000
  const WORLD_H = 3300
  const CARD_W = 280
  const CARD_H = 200
  const MARGIN = 240 // screen-px inflate against edge pop-in

  const rand = S.mulberry32(42)
  const FORMULAS = [
    '\\int_0^\\infty e^{-x^2}\\,dx = \\frac{\\sqrt{\\pi}}{2}',
    'e^{i\\pi} + 1 = 0',
    '\\nabla \\times \\mathbf{B} = \\mu_0 \\mathbf{J}',
    '\\sum_{n=1}^{\\infty} \\frac{1}{n^2} = \\frac{\\pi^2}{6}',
  ]

  const cards = Array.from({ length: COUNT }, (_, i) => ({
    i,
    x: 100 + rand() * (WORLD_W - CARD_W - 200),
    y: 100 + rand() * (WORLD_H - CARD_H - 200),
    el: null,
  }))

  // cv engagement oracle: cvSkipped === 0 at the end of a cv mode means
  // content-visibility never skipped anything under the transformed ancestor
  // — the row is then an unlabeled no-mitigation run and must be relabeled.
  const skipped = new Set()

  function buildEl(c, cv) {
    const el = document.createElement('div')
    el.className = cv ? 'card cv' : 'card'
    el.style.left = `${c.x}px`
    el.style.top = `${c.y}px`
    if (cv) {
      el.addEventListener('contentvisibilityautostatechange', (e) => {
        if (e.skipped) {
          skipped.add(el)
        } else {
          skipped.delete(el)
        }
      })
    }
    const math = window.katex.renderToString(FORMULAS[c.i % FORMULAS.length], {
      throwOnError: false,
    })
    el.innerHTML = `<h3>Note ${c.i}</h3><p>Some prose with <strong>emphasis</strong> and a <a href="#">wikilink</a>, long enough to wrap across a few lines like a real note body would.</p><div>${math}</div><ul><li>alpha ${c.i}</li><li>beta</li><li>gamma</li></ul>`
    return el
  }

  function cullFrame(cv) {
    const r = S.viewRect(MARGIN)
    for (const c of cards) {
      const vis = c.x < r.maxX && c.x + CARD_W > r.minX && c.y < r.maxY && c.y + CARD_H > r.minY
      if (vis) {
        if (!c.el) c.el = buildEl(c, cv)
        if (!c.el.isConnected) S.world.appendChild(c.el)
      } else if (c.el?.isConnected) {
        c.el.remove()
      }
    }
  }

  S.scenarios.cards = async ({ mode }) => {
    S.world.textContent = ''
    for (const c of cards) c.el = null
    skipped.clear()
    document.getElementById('dots').style.display = 'none'
    S.world.style.display = 'block'

    S.cam.x = 1300
    S.cam.y = 1650
    S.cam.z = 1
    S.applyCamera()

    const cull = mode === 'cull' || mode === 'cull+cv'
    const cv = mode === 'cv-all' || mode === 'cull+cv'
    if (cull) {
      cullFrame(cv)
    } else {
      // 'none' and 'cv-all': mount all 500 up front
      const frag = document.createDocumentFragment()
      for (const c of cards) {
        c.el = buildEl(c, cv)
        frag.appendChild(c.el)
      }
      S.world.appendChild(frag)
    }

    // Paint one frame BEFORE fonts.ready: Chromium requests @font-face files
    // lazily during paint, so fonts.ready can otherwise resolve before the
    // KaTeX font loads have even started.
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
    await document.fonts.ready
    await new Promise((r) => setTimeout(r, 300))

    const onFrame = cull ? () => cullFrame(cv) : null
    const st = await S.runChoreo(
      { durationMs: 12000, panX: [1300, 3700], panY: [1400, 1900], baseZ: 1, zoomAmp: 0.45 },
      onFrame,
    )
    st.mounted = S.world.childElementCount
    st.cvSkipped = skipped.size
    return st
  }
})()
