import { animate } from 'motion'
import { type CSSProperties, type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import { useHotkeys } from 'react-hotkeys-hook'

/**
 * DEV-ONLY playground for iterating on the feed "make-room" entrance: the scrollTop
 * glide that pushes the feed up when a note arrives (the real one lives in
 * useAppendReveal). It reproduces that glide faithfully (the same motion animate(start
 * to end) on a real scroller's scrollTop) on a throwaway feed of dummy notes, so you
 * can shape a custom cubic-bezier and replay instantly to feel which one you want,
 * without sending real notes.
 *
 * Tween (custom cubic-bezier) only: presets are just starting points you then tweak.
 * NOTE: this animates SCROLL, which the browser clamps to the bottom, so an OVERSHOOT
 * bezier (a control-point y above 1) will NOT bounce: the scroll just clamps. The curve
 * preview still shows the overshoot for reference. A real bounce needs a transform, not
 * scroll (a separate mechanism).
 *
 * Open with the dev hotkey (App). Replay with Space or R, close with Esc. The
 * "transition" readout is the exact motion options to paste into useAppendReveal.
 *
 * Not shipped in production: App only mounts it behind import.meta.env.DEV.
 */

const para = (n: number) => {
  const lines: string[] = []
  for (let i = 1; i <= n; i++) {
    lines.push(`paragraph ${i} of the arriving note - text so the bubble has real height`)
  }
  return lines.join('\n\n')
}

const ARRIVING = {
  short: 'a short note',
  medium: 'a medium note whose body wraps across two or three lines in the bubble',
  big: para(8),
  huge: para(24),
}
type Size = keyof typeof ARRIVING
const SIZE_KEYS = Object.keys(ARRIVING) as Size[]

// Cubic-bezier control points for quick-start presets - selecting one loads it into the
// editable curve below. Everything is a custom bezier under the hood (no opaque named
// easings, no spring) - exactly "tween (easing) + custom".
const PRESETS: Record<string, [number, number, number, number]> = {
  linear: [0, 0, 1, 1],
  easeOut: [0, 0, 0.58, 1],
  easeOutCubic: [0.22, 0.61, 0.36, 1],
  easeOutQuint: [0.22, 1, 0.36, 1],
  easeOutExpo: [0.16, 1, 0.3, 1],
  easeInOut: [0.42, 0, 0.58, 1],
  easeOutBack: [0.34, 1.56, 0.64, 1],
  easeInOutBack: [0.68, -0.6, 0.32, 1.6],
}
const PRESET_KEYS = Object.keys(PRESETS)

// Plenty of (wrapping) backdrop so the scroller ALWAYS overflows by more than any
// arriving note, so even a SHORT note starts fully below the fold and visibly rises in.
const BACKDROP: string[] = []
for (let i = 1; i <= 35; i++) {
  BACKDROP.push(`older note ${i} - some body text long enough to wrap onto a second line`)
}

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

export function RevealPlayground({ onClose }: { onClose: () => void }) {
  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const ctrlRef = useRef<{ stop: () => void } | null>(null)
  const loopTimerRef = useRef<number | undefined>(undefined)

  const [bez, setBez] = useState<[number, number, number, number]>([0.22, 1, 0.36, 1])
  const [dur, setDur] = useState(0.4)
  const [arriving, setArriving] = useState<Size>('short')
  const [loop, setLoop] = useState(false)

  const transition = { type: 'tween' as const, duration: dur, ease: bez }
  // Keep the latest config in a ref so play (and the loop) read fresh values.
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
    // Start one note-height short of the bottom (the arriving note just below the fold),
    // then glide to the true bottom - exactly useAppendReveal's geometry.
    const start = Math.max(0, end - noteH)
    sc.scrollTop = start
    ctrlRef.current = animate(start, end, {
      ...cfgRef.current,
      onUpdate: (v: number) => {
        sc.scrollTop = v
      },
      onComplete: () => {
        if (loopRef.current) loopTimerRef.current = window.setTimeout(play, 500)
      },
      // biome-ignore lint/suspicious/noExplicitAny: dev tool - transition built from UI state, valid at runtime.
    } as any)
  }, [])

  // Replay / close hotkeys. enableOnFormTags so they fire even while a slider/select (or
  // the composer behind the overlay) has focus - Space/R always replay.
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
  const setPoint = (i: number, v: number) =>
    setBez((b) => {
      const next = [...b] as [number, number, number, number]
      next[i] = v
      return next
    })

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
          reveal playground - <b style={{ color: COL.text }}>Space</b>/
          <b style={{ color: COL.text }}>R</b> replay - <b style={{ color: COL.text }}>Esc</b> close
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
          {/* margin-top:auto bottom-anchors the stack, like the real feed */}
          <div style={{ marginTop: 'auto' }}>
            {BACKDROP.map((t, i) => (
              <div key={t} style={bubble()}>
                {`${i + 1}. ${t}`}
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
          gap: 14,
        }}
      >
        <button type="button" data-testid="pg-play" onClick={play} style={btn(COL.accent)}>
          Play (Space / R)
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

        <Row label="preset to curve">
          <select
            data-testid="pg-preset"
            onChange={(e) => {
              const p = PRESETS[e.target.value]
              if (p) setBez([...p])
            }}
            style={input()}
            defaultValue=""
          >
            <option value="" disabled>
              load a preset...
            </option>
            {PRESET_KEYS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </Row>

        <BezierPreview bez={bez} />
        {(['x1', 'y1', 'x2', 'y2'] as const).map((lbl, i) => (
          <Slider
            key={lbl}
            label={lbl}
            min={i % 2 === 0 ? 0 : -1}
            max={i % 2 === 0 ? 1 : 2}
            step={0.01}
            value={bez[i] ?? 0}
            onChange={(v) => setPoint(i, v)}
          />
        ))}
        <Slider
          label="duration (s)"
          min={0.1}
          max={1.5}
          step={0.01}
          value={dur}
          onChange={setDur}
        />

        <div style={{ marginTop: 'auto' }}>
          <div style={{ color: COL.dim, fontSize: 11, marginBottom: 4 }}>
            transition (paste into useAppendReveal):
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

/**
 * SVG preview of the cubic-bezier (input t to output progress). The vertical range is
 * DYNAMIC: it expands to include any overshoot (control-point y outside [0,1]) so an
 * extreme curve is never clipped. Dashed lines mark y=0 and y=1.
 */
function BezierPreview({ bez }: { bez: [number, number, number, number] }) {
  const [x1, y1, x2, y2] = bez
  const W = 160
  const H = 160
  const pad = 18
  const yMax = Math.max(1, y1, y2) + 0.1
  const yMin = Math.min(0, y1, y2) - 0.1
  const range = yMax - yMin || 1
  const px = (x: number) => pad + x * (W - 2 * pad)
  const py = (y: number) => pad + ((yMax - y) / range) * (H - 2 * pad)
  return (
    <svg
      width={W}
      height={H}
      style={{
        background: COL.field,
        border: `1px solid ${COL.border}`,
        borderRadius: 8,
        alignSelf: 'center',
      }}
      aria-label="cubic-bezier curve"
    >
      <line x1={px(0)} y1={py(0)} x2={px(1)} y2={py(0)} stroke={COL.border} strokeDasharray="3 3" />
      <line x1={px(0)} y1={py(1)} x2={px(1)} y2={py(1)} stroke={COL.border} strokeDasharray="3 3" />
      <line x1={px(0)} y1={py(0)} x2={px(x1)} y2={py(y1)} stroke={COL.dim} />
      <line x1={px(1)} y1={py(1)} x2={px(x2)} y2={py(y2)} stroke={COL.dim} />
      <circle cx={px(x1)} cy={py(y1)} r={3} fill={COL.accent} />
      <circle cx={px(x2)} cy={py(y2)} r={3} fill={COL.accent} />
      <path
        d={`M ${px(0)} ${py(0)} C ${px(x1)} ${py(y1)} ${px(x2)} ${py(y2)} ${px(1)} ${py(1)}`}
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
