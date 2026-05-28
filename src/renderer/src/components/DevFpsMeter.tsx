import { useEffect, useRef } from 'react'

/**
 * Dev-only FPS overlay: a thin sparkline (x = time, y = fps, newest on the
 * right) plus the current smoothed value. Mounted only under
 * `import.meta.env.DEV` (see `main.tsx`) — Vite strips the dead branch and
 * tree-shakes this module out of production builds.
 *
 * Why it draws imperatively to a `<canvas>` and writes the number via
 * `ref.textContent` instead of React state: a meter that called `setState`
 * 60×/s would itself trigger a re-render every frame, polluting the very
 * frame budget it exists to measure (and showing up as scripting cost in any
 * profile). The single rAF loop here touches only the canvas 2d context and
 * one text node — no React work per frame.
 *
 * Why per-frame delta (not a 1-second frame counter): the sparkline needs
 * per-frame granularity to show the dips during a fast scroll. A 1-second
 * average smears the exact stalls we're hunting into a flat line.
 *
 * Reading it: the displayed number is an EMA (raw per-frame fps is too
 * jittery to read); the line is raw per-frame fps so individual dropped
 * frames are visible. Green ≥55, amber ≥30, red below.
 */
const WIDTH = 120
const HEIGHT = 36
const FPS_CEIL = 120

export function DevFpsMeter(): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const labelRef = useRef<HTMLSpanElement | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return
    const dpr = window.devicePixelRatio || 1
    canvas.width = WIDTH * dpr
    canvas.height = HEIGHT * dpr
    ctx.scale(dpr, dpr)

    // Ring buffer of raw per-frame fps, one column per device-independent px.
    const samples = new Array<number>(WIDTH).fill(60)
    let last = performance.now()
    let ema = 60
    let raf = 0

    const color = (fps: number) => (fps < 30 ? '#E5484D' : fps < 55 ? '#F5A623' : '#30A46C')

    const tick = (now: number) => {
      const delta = now - last
      last = now
      const fps = delta > 0 ? 1000 / delta : 0
      ema = ema * 0.9 + fps * 0.1
      samples.push(fps)
      samples.shift()

      ctx.clearRect(0, 0, WIDTH, HEIGHT)
      // 60 fps and 30 fps reference gridlines.
      ctx.strokeStyle = 'rgba(255,255,255,0.18)'
      ctx.lineWidth = 1
      for (const ref of [60, 30]) {
        const y = HEIGHT - (ref / FPS_CEIL) * HEIGHT
        ctx.beginPath()
        ctx.moveTo(0, y)
        ctx.lineTo(WIDTH, y)
        ctx.stroke()
      }
      // The trace.
      ctx.beginPath()
      for (let i = 0; i < samples.length; i++) {
        const y = HEIGHT - (Math.min(samples[i] ?? 0, FPS_CEIL) / FPS_CEIL) * HEIGHT
        if (i === 0) ctx.moveTo(i, y)
        else ctx.lineTo(i, y)
      }
      ctx.strokeStyle = color(ema)
      ctx.lineWidth = 1
      ctx.stroke()

      if (labelRef.current) {
        labelRef.current.textContent = `${Math.round(ema)}`
        labelRef.current.style.color = color(ema)
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  return (
    <div
      aria-hidden
      style={{
        position: 'fixed',
        bottom: 8,
        left: 8,
        zIndex: 99999,
        pointerEvents: 'none',
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        background: 'rgba(0,0,0,0.62)',
        padding: '4px 7px',
        borderRadius: 5,
        fontFamily: 'var(--font-mono, monospace)',
        fontSize: 11,
        lineHeight: 1,
        color: '#fff',
        userSelect: 'none',
      }}
    >
      <canvas ref={canvasRef} style={{ width: WIDTH, height: HEIGHT, display: 'block' }} />
      <span
        ref={labelRef}
        style={{ minWidth: 22, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}
      >
        60
      </span>
      <span style={{ opacity: 0.6 }}>fps</span>
    </div>
  )
}
