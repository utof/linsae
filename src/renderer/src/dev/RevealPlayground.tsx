import { useVirtualizer } from '@tanstack/react-virtual'
import { animate, cancelFrame, frame } from 'motion'
import {
  type CSSProperties,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { useHotkeys } from 'react-hotkeys-hook'
import { BezierTuner, type Cubic } from './BezierTuner'
import { btn, COL, input, Row, Slider } from './playgroundKit'

/**
 * DEV-ONLY spike for the "repulsion wave" feed entrance (v0.2.2). When a note is sent it
 * should NOT scroll the whole feed up as one rigid block — instead each note behaves like
 * a same-polarity magnet: the arriving note pushes its neighbour up, the wave ripples UP
 * the stack, and no two notes ever intersect.
 *
 * This harness reproduces the real feed faithfully so we can FEEL it and MEASURE it. A
 * headless sim (local_files/wave-sim.mjs) already proved the key result: a staggered
 * make-room settle ("flip") overlaps for ANY stagger and no spring tuning rescues it — the
 * punchy magnet feel genuinely needs a hard non-overlap constraint. So model A (PBD) is the
 * default here, and `flip` is kept as a toggle to watch that overlap happen live.
 *
 * Architecture under test (see local_files/2026-06-06-repulsion-wave-research.md):
 *   - The virtualizer owns each row's REST position via `transform: translateY(start)`.
 *   - We layer a per-row dynamic OFFSET on top: `translateY(calc(start + var(--wy)))`. The
 *     offset rides a CSS custom property set imperatively each frame, so it composes with
 *     the virtualizer's base transform WITHOUT either fighting the other and WITHOUT a React
 *     re-render per frame. `measureElement` reads `offsetHeight` (transform-immune) so the
 *     size tree / scroll-anchoring never see the offset.
 *   - Offset state lives in a `Map<noteId, …>` OUTSIDE the rows, so it survives recycling.
 *   - One `frame.update` loop (Motion's public frameloop, real `delta`) integrates a spring
 *     per offset back toward 0, then — for model A — runs a few Gauss-Seidel projection
 *     passes that forbid any adjacent gap from going negative. The projection also
 *     PROPAGATES the impulse: shoving an overlapping pair apart nudges the next row up, so
 *     the wave emerges from the constraint, not from a hand-tuned stagger.
 *   - Models: `pbd` (flip seed + projection — punchy + non-overlapping, the target),
 *     `flip` (seed only, no projection — overlaps; demonstrates why A is needed), `glide`
 *     (the OLD rigid-block scrollTop tween + the editable `BezierTuner`, for comparison and
 *     so the bezier tool survives for future animations / reverts).
 *   - NO scrollTop animation in the wave models (that was the rigid block + the #66
 *     white-wall bug class).
 *
 * Open with the dev hotkey (App, mod+shift+R). Space/R sends a note (replays), Esc closes.
 * Watch the "min row gap" readout — it turns red the instant any two notes overlap. Not
 * shipped: App only mounts it behind import.meta.env.DEV.
 */

const para = (n: number) => {
  const lines: string[] = []
  for (let i = 1; i <= n; i++) {
    lines.push(`paragraph ${i} of the arriving note - text so the bubble has real height`)
  }
  return lines.join('\n\n')
}

// Literal-keyed (no index signature) so `ARRIVING[size]` is `string`, not `string | undefined`.
const ARRIVING = {
  short: 'a short note',
  medium: para(3),
  big: para(8),
  huge: para(24),
}
type Size = keyof typeof ARRIVING
const SIZE_KEYS = Object.keys(ARRIVING) as Size[]

type Model = 'pbd' | 'flip' | 'glide'
type PNote = { id: string; body: string }

// Plenty of wrapping backdrop so the scroller always overflows and the wave has neighbours
// above the newcomer to ripple through.
const BACKDROP: PNote[] = Array.from({ length: 30 }, (_, i) => ({
  id: `b${i}`,
  body: `older note ${i + 1} - some body text long enough to wrap onto a second line`,
}))

/** Rough content-aware height estimate (px) — mirrors the real feed's intent, not its exact model. */
function estimate(n: PNote | undefined): number {
  if (!n) return 60
  const lines = Math.max((n.body.match(/\n/g)?.length ?? 0) + 1, Math.ceil(n.body.length / 60))
  return 20 + lines * 20 + 12
}

// Per-row physics state. `off` = current translateY offset (px), `vel` = its velocity,
// `delay` = ms still to wait before this row starts settling (makes the wave travel up).
type WaveState = { off: number; vel: number; delay: number }

function bubble(arriving = false): CSSProperties {
  return {
    border: `1px solid ${arriving ? COL.accent : COL.border}`,
    background: arriving ? '#1d2330' : COL.field,
    borderRadius: 14,
    padding: '8px 12px',
    color: COL.text,
    fontSize: 13,
    lineHeight: 1.4,
    whiteSpace: 'pre-wrap',
  }
}

/** Rendered rows as `{ id, idx }`, sorted top→bottom (ascending virtual index). */
function orderedRows(sc: HTMLElement): { id: string; idx: number }[] {
  return Array.from(sc.querySelectorAll<HTMLElement>('[data-pw-id]'))
    .map((el) => ({ id: el.dataset.pwId ?? '', idx: Number(el.dataset.pwIndex) }))
    .filter((r) => r.id && Number.isFinite(r.idx))
    .sort((a, b) => a.idx - b.idx)
}

export function RevealPlayground({ onClose }: { onClose: () => void }) {
  const [scrollerEl, setScrollerEl] = useState<HTMLDivElement | null>(null)
  const [notes, setNotes] = useState<PNote[]>(() => BACKDROP)
  const arrCountRef = useRef(0)

  const [model, setModel] = useState<Model>('flip')
  const [arriving, setArriving] = useState<Size>('big')
  // Wave knobs.
  const [staggerMs, setStaggerMs] = useState(20)
  const [stiffness, setStiffness] = useState(180)
  const [damping, setDamping] = useState(18)
  const [projIters, setProjIters] = useState(8)
  // Glide knobs (comparison model) — owned here, edited via the imported BezierTuner.
  const [dur, setDur] = useState(0.5)
  const [bez, setBez] = useState<Cubic>([0.22, 1, 0.36, 1])

  // Latest knobs in a ref so the frame loop + append effect read fresh values.
  const knobsRef = useRef({ model, arriving, staggerMs, stiffness, damping, projIters, dur, bez })
  knobsRef.current = { model, arriving, staggerMs, stiffness, damping, projIters, dur, bez }

  const waveRef = useRef<Map<string, WaveState>>(new Map())
  const tickRef = useRef<((data: { delta: number }) => void) | null>(null)
  const glideCtrlRef = useRef<{ stop: () => void } | null>(null)
  const prevLenRef = useRef(notes.length)
  const readoutRef = useRef<HTMLSpanElement | null>(null)

  // True from the instant a wave is armed (in `send`, BEFORE setNotes) until the loop
  // settles. The wave lives in per-row `--wy` transforms and pins scrollTop itself, so the
  // virtualizer's append-follow + scroll-anchor machinery must be OFF for the whole wave.
  // That machinery is gated on `anchorTo:'end'` (virtual-core setOptions: the whole
  // follow/anchor block runs only `if (merged.anchorTo === 'end')`), so the ONLY reliable
  // off-switch is the value passed INTO useVirtualizer — `setOptions` reads it from the
  // hook args, and a fresh `{...options}` is rebuilt every render, so a later mutation of
  // `virtualizer.options` does NOT feed back in. Crucially this must be 'start' on the
  // APPEND render (when setOptions runs), because `_willUpdate` — which fires
  // `scrollToEnd` → arms `reconcileScroll`'s self-correcting rAF loop — runs in
  // useVirtualizer's OWN layout effect, BEFORE our append layout effect. Setting it any
  // later snaps the newcomer to its slot. @see scripts/wave-reveal.mjs (proved it frame-by-frame).
  const [waveArmed, setWaveArmed] = useState(false)

  const virtualizer = useVirtualizer({
    count: notes.length,
    getScrollElement: () => scrollerEl,
    estimateSize: (i) => estimate(notes[i]),
    getItemKey: (i) => notes[i]?.id ?? i,
    anchorTo: waveArmed ? 'start' : 'end',
    followOnAppend: !waveArmed,
    scrollEndThreshold: 120,
    overscan: 8,
  })

  // Write every rendered row's `--wy` from the id-keyed map (so recycled rows get the RIGHT
  // note's offset, or 0), then measure the smallest gap between adjacent rows and surface it
  // imperatively (no React re-render in the loop).
  const paintOffsets = useCallback(() => {
    const sc = scrollerEl
    if (!sc) return
    const rows = Array.from(sc.querySelectorAll<HTMLElement>('[data-pw-id]'))
    const map = waveRef.current
    for (const el of rows) {
      const id = el.dataset.pwId
      const off = (id && map.get(id)?.off) || 0
      el.style.setProperty('--wy', `${off}px`)
    }
    // Rows are in DOM order = index order = top→bottom. Min gap between consecutive rows;
    // negative ⇒ they overlap (a note has eaten into its neighbour).
    let minGap = Number.POSITIVE_INFINITY
    let prevBottom: number | null = null
    for (const el of rows) {
      const r = el.getBoundingClientRect()
      if (prevBottom !== null) minGap = Math.min(minGap, r.top - prevBottom)
      prevBottom = r.bottom
    }
    const g = Number.isFinite(minGap) ? minGap : 0
    const out = readoutRef.current
    if (out) {
      out.textContent = `${g >= 0 ? '+' : ''}${g.toFixed(1)}px`
      out.style.color = g < -0.5 ? COL.danger : COL.dim
    }
  }, [scrollerEl])

  // With `anchorTo:'start'` (above) the unconditional `wasAtEnd` scroll jump in virtual-core's
  // resizeItem can't fire — but its DEFAULT `shouldAdjustScroll` branch still could on the
  // newcomer's first estimate→real measure. Suppress it too while a wave is armed. This
  // instance predicate is read live at resizeItem time, so setting it here in the render body
  // is in time (unlike the append-follow gate, which is locked in at the setOptions call).
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = () => !waveArmed

  const stopLoop = useCallback(() => {
    if (tickRef.current) {
      cancelFrame(tickRef.current)
      tickRef.current = null
    }
    waveRef.current.clear()
    setWaveArmed(false) // wave done: the re-render restores anchorTo:'end' + followOnAppend
    paintOffsets()
  }, [paintOffsets])

  const startLoop = useCallback(() => {
    if (tickRef.current) return // already running; it will pick up freshly-seeded entries
    const tick = (data: { delta: number }) => {
      const sc = scrollerEl
      if (!sc) {
        stopLoop()
        return
      }
      const { stiffness, damping, projIters, model } = knobsRef.current
      const dt = Math.min(data.delta, 32) / 1000
      const map = waveRef.current

      // 1. Integrate each offset toward 0 (semi-implicit / symplectic Euler — stable for
      //    stiff springs). Delayed rows just count down so the settle starts from the bottom.
      for (const s of map.values()) {
        if (s.delay > 0) {
          s.delay -= data.delta
          continue
        }
        const a = -stiffness * s.off - damping * s.vel
        s.vel += a * dt
        s.off += s.vel * dt
      }

      // 2. Model A only: PBD non-overlap projection. UP-ONLY and swept BOTTOM→TOP, so the
      //    newcomer (the bottom row) acts as the anchor: it's only ever the LOWER of a pair,
      //    so the projection never pushes it — it just rides its own spring up from +shift,
      //    and any pair that would overlap pushes ONLY the upper row up. Sweeping upward
      //    propagates that shove one row at a time — the magnet impulse emerges from the
      //    constraint, and the newcomer can never be knocked off the bottom (the bug a
      //    symmetric split would hit whenever the newcomer is taller than its neighbour). A
      //    row the wave reaches that wasn't seeded gets created at rest (off 0), then springs.
      if (model === 'pbd') {
        const rows = orderedRows(sc)
        const get = (id: string) => {
          let s = map.get(id)
          if (!s) {
            s = { off: 0, vel: 0, delay: 0 }
            map.set(id, s)
          }
          return s
        }
        for (let it = 0; it < projIters; it++) {
          for (let i = rows.length - 2; i >= 0; i--) {
            // rows[i] is upper, rows[i+1] is the lower (closer to the newcomer / pinned).
            const upperId = rows[i]?.id
            const lowerId = rows[i + 1]?.id
            if (!upperId || !lowerId) continue
            const lowerOff = map.get(lowerId)?.off ?? 0
            const upperOff = map.get(upperId)?.off ?? 0
            const gap = lowerOff - upperOff // want ≥ 0 (lower sits below upper)
            if (gap < 0) get(upperId).off += gap // push ONLY the upper up; lower stays pinned
          }
        }
      }

      // 3. Retire settled rows; stop when nothing is moving or waiting.
      let active = false
      for (const [id, s] of map) {
        if (s.delay > 0) {
          active = true
        } else if (Math.abs(s.off) < 0.05 && Math.abs(s.vel) < 0.5) {
          map.delete(id)
        } else {
          active = true
        }
      }
      paintOffsets()
      if (!active) stopLoop()
    }
    tickRef.current = tick
    frame.update(tick, true)
  }, [scrollerEl, paintOffsets, stopLoop])

  // Send a note: append a fresh arriving note (trims old arrivals so the list can't grow
  // unbounded across replays). The append effect below runs the entrance.
  const send = useCallback(() => {
    // Arm the guard BEFORE setNotes so `waveArmed` is already true on the append render —
    // i.e. when useVirtualizer's setOptions runs and decides whether to follow-on-append.
    // (Both setState calls batch into that one render.) `glide` drives scrollTop itself and
    // cooperates with the virtualizer's follow, so it stays unguarded.
    if (knobsRef.current.model !== 'glide') setWaveArmed(true)
    setNotes((prev) => {
      const base = prev.length > BACKDROP.length + 4 ? prev.slice(0, BACKDROP.length) : prev
      arrCountRef.current += 1
      return [
        ...base,
        { id: `arr${arrCountRef.current}`, body: ARRIVING[knobsRef.current.arriving] },
      ]
    })
  }, [])

  // Entrance, fired on a single append. Layout effect (pre-paint) so the FLIP invert shows
  // no pop. Mirrors the real `useAppendReveal` append-detection.
  useLayoutEffect(() => {
    const len = notes.length
    const grew = len === prevLenRef.current + 1
    prevLenRef.current = len
    if (!grew) return
    const sc = scrollerEl
    if (!sc) return
    const newIndex = len - 1
    const newNode = sc.querySelector<HTMLElement>(`[data-index="${newIndex}"]`)
    if (!newNode) return
    const shift = newNode.offsetHeight // transform-immune (matches virtual-core's measure)
    if (shift <= 0) return
    const { model } = knobsRef.current

    if (model === 'glide') {
      // Comparison only: the OLD rigid-block scrollTop tween, driven by the BezierTuner curve.
      glideCtrlRef.current?.stop()
      const end = sc.scrollHeight - sc.clientHeight
      const start = Math.max(0, end - shift)
      sc.scrollTop = start
      glideCtrlRef.current = animate(start, end, {
        type: 'tween',
        duration: knobsRef.current.dur,
        ease: knobsRef.current.bez,
        onUpdate: (v: number) => {
          sc.scrollTop = v
        },
        // biome-ignore lint/suspicious/noExplicitAny: dev tool, options valid at runtime.
      } as any)
      return
    }

    // WAVE (pbd / flip): pin to the true bottom, then seed EVERY row from the newcomer up at
    // +shift — including the newcomer ITSELF, so it starts one note-height below its slot
    // (off-screen, below the fold) and RISES into view instead of popping in at the bottom.
    // (Popping it in was the dominant overlap source: the neighbour's old position sits on top
    // of a newcomer that's already there.) Everything springs back to 0; the newcomer leads
    // (delay 0) and, as it rises, shoves the row above it up — `pbd` enforces that with the
    // projection (true magnet repulsion); `flip` lets the stagger do it and overlaps softly.
    // `waveArmed` was set true in `send` (so the append render already suppressed the
    // virtualizer's follow); pin to the true bottom, then own the reveal via `--wy`.
    sc.scrollTop = sc.scrollHeight
    const map = waveRef.current
    for (const { id, idx } of orderedRows(sc)) {
      if (idx > newIndex) continue
      const d = newIndex - idx // 0 = the newcomer itself, 1 = immediate neighbour above, …
      map.set(id, { off: shift, vel: 0, delay: d * knobsRef.current.staggerMs })
    }
    paintOffsets() // first paint: whole stack at +shift (newcomer below the fold), no pop
    startLoop()
  }, [notes, scrollerEl, paintOffsets, startLoop])

  // Initial scroll-to-bottom once the scroller mounts.
  // biome-ignore lint/correctness/useExhaustiveDependencies: one-shot; depends on scroller availability + stable virtualizer identity.
  useLayoutEffect(() => {
    if (scrollerEl && notes.length > 0) virtualizer.scrollToEnd()
  }, [scrollerEl])

  const hkOpts = { enableOnFormTags: ['textarea', 'input', 'select'] as const }
  useHotkeys(
    'space',
    (e) => {
      e.preventDefault()
      send()
    },
    hkOpts,
    [send],
  )
  useHotkeys('r', () => send(), hkOpts, [send])
  useHotkeys('escape', () => onClose(), hkOpts)

  // Cleanup on unmount.
  useEffect(
    () => () => {
      glideCtrlRef.current?.stop()
      if (tickRef.current) cancelFrame(tickRef.current)
    },
    [],
  )

  const handleScrollerRef = useCallback((el: HTMLDivElement | null) => setScrollerEl(el), [])

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        display: 'flex',
        background: 'rgba(0,0,0,0.55)',
        backdropFilter: 'blur(2px)',
        fontFamily: 'var(--font-sans, system-ui)',
      }}
    >
      {/* Virtualized dummy feed — same shape as the real Feed. */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: 24, minWidth: 0 }}>
        <div style={{ color: COL.dim, fontSize: 12, marginBottom: 8 }}>
          repulsion-wave spike — <b style={{ color: COL.text }}>Space</b>/
          <b style={{ color: COL.text }}>R</b> send · <b style={{ color: COL.text }}>Esc</b> close ·
          scroll mid-wave to stress recycling
        </div>
        <div
          ref={handleScrollerRef}
          style={{
            flex: 1,
            overflowY: 'auto',
            overflowX: 'hidden',
            border: `1px solid ${COL.border}`,
            borderRadius: 12,
            padding: '0 16px',
            background: COL.panel,
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <div
            style={{
              height: virtualizer.getTotalSize(),
              width: '100%',
              position: 'relative',
              marginTop: 'auto',
              flexShrink: 0,
            }}
          >
            {virtualizer.getVirtualItems().map((vi) => {
              const note = notes[vi.index]
              if (!note) return null
              return (
                <div
                  key={vi.key}
                  ref={virtualizer.measureElement}
                  data-index={vi.index}
                  data-pw-id={note.id}
                  data-pw-index={vi.index}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    // Base translate from the virtualizer + a per-row offset on top (the wave).
                    transform: `translateY(calc(${vi.start}px + var(--wy, 0px)))`,
                    paddingTop: 6,
                    paddingBottom: 6,
                  }}
                >
                  <div style={bubble(note.id.startsWith('arr'))}>{note.body}</div>
                </div>
              )
            })}
          </div>
        </div>
      </div>

      {/* Controls */}
      <div
        style={{
          width: 320,
          background: COL.panel,
          borderLeft: `1px solid ${COL.border}`,
          padding: 20,
          color: COL.text,
          overflowY: 'auto',
          display: 'flex',
          flexDirection: 'column',
          gap: 14,
        }}
      >
        <button type="button" data-testid="pg-play" onClick={send} style={btn(COL.accent)}>
          Send (Space / R)
        </button>

        <Row label="min row gap">
          <span
            ref={readoutRef}
            style={{ color: COL.dim, fontSize: 12, fontVariantNumeric: 'tabular-nums' }}
          >
            +0.0px
          </span>
        </Row>
        <div style={{ color: COL.dim, fontSize: 11, marginTop: -8 }}>
          turns <span style={{ color: COL.danger }}>red</span> if any two notes overlap
        </div>

        <Row label="model">
          <select value={model} onChange={(e) => setModel(e.target.value as Model)} style={input()}>
            <option value="pbd">A · PBD (punchy + safe)</option>
            <option value="flip">flip (no projection — overlaps)</option>
            <option value="glide">glide (old scrollTop + bezier)</option>
          </select>
        </Row>
        <Row label="arriving note">
          <select
            value={arriving}
            onChange={(e) => setArriving(e.target.value as Size)}
            style={input()}
          >
            {SIZE_KEYS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </Row>

        {model === 'glide' ? (
          <BezierTuner bez={bez} setBez={setBez} dur={dur} setDur={setDur} />
        ) : (
          <>
            <Slider
              label="stagger (ms/row)"
              min={0}
              max={80}
              step={1}
              value={staggerMs}
              onChange={setStaggerMs}
            />
            <Slider
              label="stiffness"
              min={20}
              max={600}
              step={5}
              value={stiffness}
              onChange={setStiffness}
            />
            <Slider
              label="damping"
              min={2}
              max={60}
              step={1}
              value={damping}
              onChange={setDamping}
            />
            {model === 'pbd' && (
              <Slider
                label="projection passes"
                min={1}
                max={24}
                step={1}
                value={projIters}
                onChange={setProjIters}
              />
            )}
          </>
        )}

        <div style={{ marginTop: 'auto', color: COL.dim, fontSize: 11, lineHeight: 1.5 }}>
          {model === 'pbd'
            ? 'model A: flip seed + per-frame non-overlap projection. The projection also propagates the impulse upward, so the wave emerges from the constraint.'
            : model === 'flip'
              ? 'flip: settle a make-room shift with no constraint. Watch the gap go red — this is why A exists.'
              : 'glide: the old rigid-block scrollTop tween, shaped by the bezier tuner. Kept for comparison + future tween animations.'}
        </div>
      </div>
    </div>
  )
}
