import type { CSSProperties, ReactNode } from 'react'

/**
 * Shared UI primitives for the DEV-only animation playgrounds (RevealPlayground,
 * BezierTuner). Kept tiny and dependency-free so each playground stays a self-contained,
 * easily-revertable dev tool. Not shipped: only imported behind import.meta.env.DEV.
 */

export const COL = {
  panel: '#16181d',
  field: '#22252c',
  border: '#2c2f37',
  text: '#e6e8ec',
  dim: '#8b909a',
  accent: '#3b82f6',
  danger: '#ff5d5d',
}

export function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
      <span style={{ color: COL.dim, fontSize: 12 }}>{label}</span>
      {children}
    </div>
  )
}

export function Slider({
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

export function btn(bg: string): CSSProperties {
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

export function input(): CSSProperties {
  return {
    background: COL.field,
    color: COL.text,
    border: `1px solid ${COL.border}`,
    borderRadius: 6,
    padding: '4px 8px',
    fontSize: 12,
  }
}
