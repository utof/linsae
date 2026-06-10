import { btn, COL, input, Row, Slider } from './playgroundKit'

/**
 * DEV-ONLY cubic-bezier curve editor — extracted from the original RevealPlayground so the
 * bezier-tuning capability survives the move to the repulsion-wave spike. Controlled: the
 * parent owns the `[x1,y1,x2,y2]` control points and the duration; this just renders the
 * presets, an uncropped curve preview (shows overshoot), the four control-point sliders, a
 * duration slider, and a copy-able `transition` object.
 *
 * Kept around for future tween-based animations and as a fast way to recover / re-tune the
 * pre-wave scroll-glide bezier if we ever revert. Imported into RevealPlayground's `glide`
 * mode. Not shipped: only mounted behind import.meta.env.DEV.
 */

export type Cubic = [number, number, number, number]

// Quick-start presets — selecting one loads it into the editable curve. Everything is a
// plain cubic-bezier under the hood (no opaque named easings, no spring).
const PRESETS: Record<string, Cubic> = {
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

export function BezierTuner({
  bez,
  setBez,
  dur,
  setDur,
}: {
  bez: Cubic
  setBez: (b: Cubic) => void
  dur: number
  setDur: (d: number) => void
}) {
  const setPoint = (i: number, v: number) =>
    setBez(bez.map((c, idx) => (idx === i ? v : c)) as Cubic)
  const transitionCode = JSON.stringify({ type: 'tween', duration: dur, ease: bez })

  return (
    <>
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
      <Slider label="duration (s)" min={0.1} max={1.5} step={0.01} value={dur} onChange={setDur} />

      <div>
        <div style={{ color: COL.dim, fontSize: 11, marginBottom: 4 }}>
          transition (paste into useGlideReveal):
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
    </>
  )
}

/**
 * SVG preview of the cubic-bezier (input t → output progress). The vertical range is
 * DYNAMIC: it expands to include any overshoot (control-point y outside [0,1]) so an extreme
 * curve is never clipped. Dashed lines mark y=0 and y=1.
 */
function BezierPreview({ bez }: { bez: Cubic }) {
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
