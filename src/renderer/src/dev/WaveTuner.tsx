import { useState } from 'react'
import {
  DEFAULT_WAVE_TUNING,
  resetWaveTuning,
  setWaveTuning,
  useWaveTuning,
  type WaveTuning,
} from '../feed/entrance/wave-tuning'
import { useFeedEntrance } from '../lib/anim-pref'

/**
 * Dev-only floating panel to tune the wave entrance (flip / pbd) live on the REAL feed.
 * Sliders write `lib`-style localStorage overrides ({@link setWaveTuning}); the wave reads
 * them per send. The amplitude floor/multiplier are the perceptibility lever — a short note's
 * rise = its height, so without a floor the flip↔pbd difference is sub-perceptible for small
 * notes. Dial values here, then bake the keepers into `DEFAULT_WAVE_TUNING`.
 *
 * Mounted only when `import.meta.env.DEV` (App.tsx) → tree-shaken from production builds.
 * @see src/renderer/src/feed/entrance/wave-tuning.ts
 */
export function WaveTuner() {
  const t = useWaveTuning()
  const entrance = useFeedEntrance()
  const [open, setOpen] = useState(true)
  const waveActive = entrance === 'flip' || entrance === 'pbd'

  const panel: React.CSSProperties = {
    position: 'fixed',
    top: 8,
    right: 8,
    zIndex: 9999,
    width: open ? 248 : 'auto',
    background: 'var(--bg-2, #1b1b1b)',
    border: '1px solid var(--border-0, #333)',
    borderRadius: 10,
    padding: open ? '10px 12px' : '4px 8px',
    font: '11px/1.4 var(--font-sans, system-ui)',
    color: 'var(--fg-2, #ccc)',
    boxShadow: '0 6px 24px rgba(0,0,0,0.4)',
    userSelect: 'none',
  }

  return (
    <div style={panel}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        style={{
          all: 'unset',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          color: 'var(--fg-1, #eee)',
          fontWeight: 600,
        }}
      >
        <span>{open ? '▾' : '▸'} wave tuner</span>
        <span style={{ color: waveActive ? 'var(--accent, #4ea1ff)' : 'var(--fg-3, #888)' }}>
          {entrance}
        </span>
      </button>

      {open && (
        <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
          {!waveActive && (
            <div style={{ color: 'var(--fg-3, #888)', marginBottom: 4 }}>
              wave runs for flip / pbd — pick one in settings to see these take effect.
            </div>
          )}
          <Row label="amp floor" v={t.ampFloor} min={0} max={400} step={5} k="ampFloor" />
          <Row label="amp ×" v={t.ampMult} min={0.25} max={3} step={0.05} k="ampMult" dp={2} />
          <Row label="stiffness" v={t.stiffness} min={20} max={400} step={5} k="stiffness" />
          <Row label="damping" v={t.damping} min={2} max={50} step={1} k="damping" />
          <Row label="stagger ms" v={t.staggerMs} min={0} max={80} step={2} k="staggerMs" />
          <Row label="proj pass" v={t.projPasses} min={1} max={16} step={1} k="projPasses" />
          <button
            type="button"
            onClick={resetWaveTuning}
            style={{
              all: 'unset',
              cursor: 'pointer',
              marginTop: 4,
              textAlign: 'center',
              padding: '3px 0',
              borderRadius: 6,
              border: '1px solid var(--border-0, #333)',
              color: 'var(--fg-2, #ccc)',
            }}
          >
            reset to defaults
          </button>
        </div>
      )}
    </div>
  )
}

/** One labelled slider that writes a single tuning key on change. */
function Row(props: {
  label: string
  v: number
  min: number
  max: number
  step: number
  k: keyof WaveTuning
  dp?: number
}) {
  const { label, v, min, max, step, k, dp } = props
  const isDefault = v === DEFAULT_WAVE_TUNING[k]
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <span style={{ width: 64, flex: '0 0 auto' }}>{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={v}
        onChange={(e) => setWaveTuning({ [k]: Number(e.target.value) })}
        style={{ flex: 1, minWidth: 0, accentColor: 'var(--accent, #4ea1ff)' }}
      />
      <span
        style={{
          width: 34,
          flex: '0 0 auto',
          textAlign: 'right',
          fontVariantNumeric: 'tabular-nums',
          color: isDefault ? 'var(--fg-3, #888)' : 'var(--fg-1, #eee)',
        }}
      >
        {dp ? v.toFixed(dp) : v}
      </span>
    </label>
  )
}
