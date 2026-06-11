// Interactive ink-latency check (mode=ink only). Two questions for THIS
// platform (Linux x11 — desynchronized support is historically spotty there):
//   1. does getContext('2d', {desynchronized:true}) actually take effect?
//      (getContextAttributes().desynchronized is the ground truth)
//   2. how many coalesced samples per pointermove do we get from this input
//      stack? (research update Tier 1 item 4 — stroke fidelity / hot elbows)
// Keys: d = toggle desynchronized (rebuilds canvas), c = clear.
;(() => {
  const params = new URLSearchParams(location.search)
  if (params.get('mode') !== 'ink') return
  document.getElementById('viewport').style.display = 'none'
  const hud = document.getElementById('hud')

  let desync = true
  let canvas = null
  let ctx = null
  let drawing = false
  let moves = 0
  let samples = 0

  function rebuild() {
    canvas?.remove()
    moves = 0
    samples = 0
    canvas = document.createElement('canvas')
    canvas.style.cssText = 'position:fixed;inset:0;touch-action:none'
    const dpr = devicePixelRatio
    canvas.width = Math.round(innerWidth * dpr)
    canvas.height = Math.round(innerHeight * dpr)
    document.body.appendChild(canvas)
    ctx = canvas.getContext('2d', { desynchronized: desync })
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.lineWidth = 2
    ctx.strokeStyle = '#1a1a2e'
    updateHud()

    canvas.onpointerdown = (e) => {
      canvas.setPointerCapture(e.pointerId)
      drawing = true
      ctx.beginPath()
      ctx.moveTo(e.offsetX, e.offsetY)
    }
    canvas.onpointermove = (e) => {
      if (!drawing) return
      const coalesced = e.getCoalescedEvents ? e.getCoalescedEvents() : [e]
      moves += 1
      samples += coalesced.length
      for (const c of coalesced) ctx.lineTo(c.offsetX, c.offsetY)
      ctx.stroke()
      updateHud()
    }
    canvas.onpointerup = () => {
      drawing = false
    }
  }

  function updateHud() {
    const got = ctx.getContextAttributes ? ctx.getContextAttributes().desynchronized : 'n/a'
    const ratio = moves ? (samples / moves).toFixed(2) : '—'
    hud.textContent = `requested desynchronized=${desync}  actual=${got}\ncoalesced samples/move=${ratio} (${samples}/${moves})\nd=toggle desync  c=clear`
  }

  window.addEventListener('keydown', (e) => {
    if (e.key === 'd') {
      desync = !desync
      rebuild()
    }
    if (e.key === 'c') {
      ctx.clearRect(0, 0, innerWidth, innerHeight)
    }
  })

  rebuild()
})()
