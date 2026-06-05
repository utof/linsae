import { animate } from 'motion'
import { type CSSProperties, type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import { useHotkeys } from 'react-hotkeys-hook'

/**
 * DEV-ONLY playground for iterating on the feed "make-room" entrance — the
 * `scrollTop` glide that pushes the feed up when a note arrives (the real one lives
 * in `useAppendReveal`). It reproduces that glide faithfully (same `motion`
 * `animate(start → end)` on a real scroller's `scrollTop`) on a throwaway feed of
 * dummy notes, so you can swap the easing/spring + params and replay instantly to
 * feel which one you want, without sending real notes.
 *
 * Open it with the dev hotkey (see App). Replay with **Space** or **R**, close with
 * **Esc**. The "transition" readout at the bottom is the exact `motion` options — copy
 * it straight into `useAppendReveal`'s `animate(...)` once you've picked one.
 *
 * Not shipped in production: App only mounts it behind `import.meta.env.DEV`.
 */

const para = (n: number) =>
  Array.from(
    { length: n },
    (_, i) =>
      `paragraph ${i + 1} of the arriving note — enough text that the bubble has real height to push the feed up`,
  ).join('\n\n')

const ARRIVING = {
  short: 'a short note',
  medium: 'a medium note whose body wraps across two or three lines in the bubble',
  big: para(8),
  huge: para(24),
}
type Size = keyof typeof ARRIVING
const SIZE_KEYS = Object.keys(ARRIVING) as Size[]

// Named `motion` tween easings (+ 'custom' → a tunable cubic-bezier).
const EASINGS = [
  'linear',
  'easeIn',
  'easeOut',
  'easeInOut',
  'circIn',
  'circOut',
  'circInOut',
  'backIn',
  'backOut',
  'backInOut',
  'anticipate',
  'custom',
] as const

// Backdrop notes the arriving one pushes up — enough (and tall enough) to overflow the
// scroller well, so even a big arriving note has room to glide.
const BACKDROP = Array.from(
  { length: 18 },
  (_, i) =>
    `older note ${i + 1} — some body text long enough to wrap onto a second line so the feed overflows`,
)

const COL = {
  panel: '#16181d',
  field: '#22252c',
  border: '#2c2f37',
  text: '#e6e8ec',
  dim: '#8b909a',
  accent: '#3b82f6',
}

function bubble(arriving = false): CSSProperties {
  return {
    border: `1px solid ${arriving ? COL.accent : COL.border}`,
    background: arriving ? '#1d2330' : COL.field,
    borderRadius: 14,
    padding: '8px 12px',
    margin: '6px 0',
    color: COL.text,
    fontSize: 13,
    lineHeight: 1.4,
    whiteSpace: 'pre-wrap',
  }
}

/**
 * The exact `motion` transition for the current control state. This object is what
 * the real `useAppendReveal` would pass to `animate(start, end, { ...this })`.
 */
type Transition =
  | { type: 'spring'; bounce: number; visualDuration: number }
  | { type: 'tween'; duration: number; ease: string | number[] }

export function RevealPlayground({ onClose }: { onClose: () => void }) {
  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const ctrlRef = useRef<{ stop: () => void } | null>(null)
  const loopTimerRef = useRef<number | undefined>(undefined)

  const [animType, setAnimType] = useState<'spring' | 'tween'>('spring')
  const [bounce, setBounce] = useState(0)
  const [springDur, setSpringDur] = useState(0.4)
  const [ease, setEase] = useState<(typeof EASINGS)[number]>('easeOut')
  const [bez, setBez] = useState<[number, number, number, number]>([0.22, 1, 0.36, 1])
  const [tweenDur, setTweenDur] = useState(0.4)
  const [arriving, setArriving] = useState<Size>('big')
  const [loop, setLoop] = useState(false)

  const transition: Transition =
    animType === 'spring'
      ? { type: 'spring', bounce, visualDuration: springDur }
      : { type: 'tween', duration: tweenDur, ease: ease === 'custom' ? bez : ease }
  // Keep the latest config in a ref so `play` (and the loop) always read fresh values
  // without being re-created mid-animation.
  const cfgRef = useRef(transition)
  cfgRef.current = transition
  const loopRef = useRef(loop)
  loopRef.current = loop

  const play = useCallback(() => {
    const sc = scrollerRef.current
    if (!sc) return
    ctrlRef.current?.stop()
    if (loopTimerRef.current !== undefined) clearTimeout(loopTimerRef.current)
    const last = sc.querySelector<HTMLElement>('[data-arriving]')
    const noteH = last ? last.getBoundingClientRect().height : 80
    const end = sc.scrollHeight - sc.clientHeight
    // Start one note-height short of the bottom (the arriving note just below the
    // fold), then glide to the true bottom — exactly `useAppendReveal`'s geometry.
    const start = Math.max(0, end - noteH)
    sc.scrollTop = start
    // `cfgRef.current` is a valid motion transition; cast for the numeric `animate`
    // overload (its `ease` union is narrower than our string|bezier control state).
    ctrlRef.current = animate(start, end, {
      ...(cfgRef.current as object),
      onUpdate: (v: number) => {
        sc.scrollTop = v
      },
      onComplete: () => {
        if (loopRef.current) loopTimerRef.current = window.setTimeout(play, 500)
      },
      // biome-ignore lint/suspicious/noExplicitAny: dev tool — transition built from UI state, valid at runtime.
    } as any)
  }, [])

  // Replay / close hotkeys. enableOnFormTags so they fire even while a slider/select
  // (or the composer behind the overlay) has focus — Space/R always replay.
  const hkOpts = { enableOnFormTags: ['textarea', 'input', 'select'] as const }
  useHotkeys(
    'space',
    (e) => {
      e.preventDefault()
      play()
    },
    hkOpts,
    [play],
  )
  useHotkeys('r', () => play(), hkOpts, [play])
  useHotkeys('escape', () => onClose(), hkOpts)

  // Pin to the bottom on open so the first Play has somewhere to glide from.
  useEffect(() => {
    const sc = scrollerRef.current
    if (sc) sc.scrollTop = sc.scrollHeight
    return () => {
      ctrlRef.current?.stop()
      if (loopTimerRef.current !== undefined) clearTimeout(loopTimerRef.current)
    }
  }, [])

  const transitionCode = JSON.stringify(transition)

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
      {/* Dummy feed */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: 24, minWidth: 0 }}>
        <div style={{ color: COL.dim, fontSize: 12, marginBottom: 8 }}>
          reveal playground — <b style={{ color: COL.text }}>Space</b>/
          <b style={{ color: COL.text }}>R</b> replay · <b style={{ color: COL.text }}>Esc</b> close
        </div>
        <div
          ref={scrollerRef}
          style={{
            flex: 1,
            overflowY: 'auto',
            border: `1px solid ${COL.border}`,
            borderRadius: 12,
            padding: '0 16px',
            background: COL.panel,
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          {/* margin-top:auto bottom-anchors a short stack, like the real feed */}
          <div style={{ marginTop: 'auto' }}>
            {BACKDROP.map((t, i) => (
              <div key={t} style={bubble()}>
                {`${i + 1}· ${t}`}
              </div>
            ))}
            <div data-arriving="" style={bubble(true)}>
              {ARRIVING[arriving]}
            </div>
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
          gap: 16,
        }}
      >
        <button type="button" data-testid="pg-play" onClick={play} style={btn(COL.accent)}>
          ▶ Play (Space / R)
        </button>
        <Row label="loop">
          <input type="checkbox" checked={loop} onChange={(e) => setLoop(e.target.checked)} />
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

        <Row label="type">
          <select
            value={animType}
            onChange={(e) => setAnimType(e.target.value as 'spring' | 'tween')}
            style={input()}
          >
            <option value="spring">spring</option>
            <option value="tween">tween (easing)</option>
          </select>
        </Row>

        {animType === 'spring' ? (
          <>
            <Slider
              label="bounce"
              min={0}
              max={1}
              step={0.01}
              value={bounce}
              onChange={setBounce}
            />
            <Slider
              label="visualDuration (s)"
              min={0.1}
              max={1.5}
              step={0.01}
              value={springDur}
              onChange={setSpringDur}
            />
          </>
        ) : (
          <>
            <Row label="easing">
              <select
                value={ease}
                onChange={(e) => setEase(e.target.value as (typeof EASINGS)[number])}
                style={input()}
              >
                {EASINGS.map((e) => (
                  <option key={e} value={e}>
                    {e}
                  </option>
                ))}
              </select>
            </Row>
            {ease === 'custom' && (
              <>
                <BezierPreview bez={bez} />
                {(['x1', 'y1', 'x2', 'y2'] as const).map((lbl, i) => (
                  <Slider
                    key={lbl}
                    label={lbl}
                    min={i % 2 === 0 ? 0 : -0.5}
                    max={i % 2 === 0 ? 1 : 1.5}
                    step={0.01}
                    value={bez[i] ?? 0}
                    onChange={(v) =>
                      setBez((b) => {
                        const next = [...b] as [number, number, number, number]
                        next[i] = v
                        return next
                      })
                    }
                  />
                ))}
              </>
            )}
            <Slider
              label="duration (s)"
              min={0.1}
              max={1.5}
              step={0.01}
              value={tweenDur}
              onChange={setTweenDur}
            />
          </>
        )}

        <div style={{ marginTop: 'auto' }}>
          <div style={{ color: COL.dim, fontSize: 11, marginBottom: 4 }}>
            transition (copy into useAppendReveal):
          </div>
          <code
            style={{
              display: 'block',
              background: COL.field,
              border: `1px solid ${COL.border}`,
              borderRadius: 8,
              padding: '8px 10px',
              fontSize: 11,
              wordBreak: 'break-all',
              color: COL.text,
            }}
          >
            {transitionCode}
          </code>
          <button
            type="button"
            onClick={() => navigator.clipboard.writeText(transitionCode)}
            style={btn(COL.field)}
          >
            copy
          </button>
        </div>
      </div>
    </div>
  )
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
      <span style={{ color: COL.dim, fontSize: 12 }}>{label}</span>
      {children}
    </div>
  )
}

function Slider({
  label,
  min,
  max,
  step,
  value,
  onChange,
}: {
  label: string
  min: number
  max: number
  step: number
  value: number
  onChange: (v: number) => void
}) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span
        style={{ color: COL.dim, fontSize: 12, display: 'flex', justifyContent: 'space-between' }}
      >
        <span>{label}</span>
        <span style={{ color: COL.text }}>{value.toFixed(2)}</span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  )
}

/** Small SVG preview of the custom cubic-bezier curve (input t → output progress). */
function BezierPreview({ bez }: { bez: [number, number, number, number] }) {
  const [x1, y1, x2, y2] = bez
  const S = 100
  // y grows DOWN in SVG, and our easing y can exceed [0,1] (overshoot), so map y→up.
  const py = (y: number) => S - y * S
  return (
    <svg
      width={S}
      height={S}
      style={{
        background: COL.field,
        border: `1px solid ${COL.border}`,
        borderRadius: 8,
        alignSelf: 'center',
      }}
      aria-label="bezier curve"
    >
      <line x1={0} y1={py(0)} x2={S} y2={py(0)} stroke={COL.border} />
      <line x1={0} y1={py(1)} x2={S} y2={py(1)} stroke={COL.border} />
      <path
        d={`M 0 ${py(0)} C ${x1 * S} ${py(y1)} ${x2 * S} ${py(y2)} ${S} ${py(1)}`}
        fill="none"
        stroke={COL.accent}
        strokeWidth={2}
      />
    </svg>
  )
}

function btn(bg: string): CSSProperties {
  return {
    width: '100%',
    padding: '8px 12px',
    background: bg,
    color: COL.text,
    border: `1px solid ${COL.border}`,
    borderRadius: 8,
    cursor: 'pointer',
    fontSize: 13,
    marginTop: 6,
  }
}

function input(): CSSProperties {
  return {
    background: COL.field,
    color: COL.text,
    border: `1px solid ${COL.border}`,
    borderRadius: 6,
    padding: '4px 8px',
    fontSize: 12,
  }
}
