import { useState } from 'react'
import { useHotkeys } from 'react-hotkeys-hook'
import { setCanvasDevLod, useCanvasDevLod } from '../canvas/dev-lod'
import { type DevOverlayKey, toggleOverlay, useDevOverlay } from './devOverlays'
import { COL, Row } from './playgroundKit'

const OVERLAYS: { key: DevOverlayKey; label: string }[] = [
  { key: 'fps', label: 'FPS meter' },
  { key: 'boot', label: 'Boot meter' },
  { key: 'wave', label: 'Wave tuner' },
  { key: 'reveal', label: 'Reveal playground' },
]

function OverlayRow({ k, label }: { k: DevOverlayKey; label: string }) {
  const on = useDevOverlay(k)
  return (
    <Row label={label}>
      <input type="checkbox" checked={on} onChange={() => toggleOverlay(k)} />
    </Row>
  )
}

/** Active button style for the LOD tier selector. */
const TIER_BTN_BASE: React.CSSProperties = {
  padding: '2px 8px',
  borderRadius: 4,
  border: `1px solid ${COL.border}`,
  cursor: 'pointer',
  fontSize: 11,
  fontFamily: 'ui-monospace, monospace',
  background: COL.field,
  color: COL.dim,
}

const TIER_BTN_ACTIVE: React.CSSProperties = {
  ...TIER_BTN_BASE,
  background: COL.accent,
  color: '#fff',
  borderColor: COL.accent,
}

/**
 * LOD section rendered inside the DevToolsHud. Reads from / writes to the
 * ephemeral CanvasDevLod store.
 *
 * Why separated: keeps the HUD component readable and the LOD logic cohesive.
 * @see src/renderer/src/canvas/dev-lod.ts
 */
function LodSection() {
  const lod = useCanvasDevLod()
  const tiers: Array<'auto' | 'card' | 'dot'> = ['auto', 'card', 'dot']
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span style={{ color: COL.dim, fontSize: 11, letterSpacing: 0.4 }}>LOD</span>
      {/* Tier 3-way toggle */}
      <div style={{ display: 'flex', gap: 4 }}>
        {tiers.map((t) => (
          <button
            key={t}
            type="button"
            style={lod.forceTier === t ? TIER_BTN_ACTIVE : TIER_BTN_BASE}
            onClick={() => setCanvasDevLod({ forceTier: t })}
          >
            {t}
          </button>
        ))}
      </div>
      {/* Unclamp zoom checkbox */}
      <Row label="unclamp zoom">
        <input
          type="checkbox"
          checked={lod.unclampZoom}
          onChange={(e) => setCanvasDevLod({ unclampZoom: e.target.checked })}
        />
      </Row>
      {/* Synthetic 10k dots checkbox */}
      <Row label="synthetic 10k dots">
        <input
          type="checkbox"
          checked={lod.syntheticDots}
          onChange={(e) => setCanvasDevLod({ syntheticDots: e.target.checked })}
        />
      </Row>
    </div>
  )
}

/**
 * DEV-only dev-tools HUD: `mod+shift+d` toggles a corner panel with a live on/off checkbox
 * per dev overlay. One global hotkey for all current + future overlays.
 *
 * `defaultOpen` is a test affordance — pass `defaultOpen` in component tests to render
 * the panel without needing to simulate `mod+shift+d` (which is platform-dependent under
 * happy-dom). Production code should never pass this prop.
 *
 * Why: react-hotkeys-hook v5 attaches listeners to `document`; happy-dom's `mod` key
 * resolution varies by platform, making the hotkey unreliable in test environments.
 *
 * @see docs/specs/v0.2.4-dev-tools-hud.md
 * @see adrs/0024-dev-tools-hud.md
 */
export function DevToolsHud({ defaultOpen = false }: { defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  useHotkeys(
    'mod+shift+d',
    (e) => {
      e.preventDefault()
      setOpen((o) => !o)
    },
    { enableOnFormTags: ['textarea', 'input'] },
  )
  if (!open) return null
  return (
    <div
      data-testid="dev-tools-hud"
      style={{
        position: 'fixed',
        top: 12,
        left: 12,
        zIndex: 9999,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        padding: 12,
        minWidth: 180,
        background: COL.panel,
        border: `1px solid ${COL.border}`,
        borderRadius: 10,
        color: COL.text,
        font: '12px/1.4 ui-monospace, monospace',
      }}
    >
      <span style={{ color: COL.dim, fontSize: 11, letterSpacing: 0.5 }}>DEV TOOLS · ⇧⌘D</span>
      {OVERLAYS.map((o) => (
        <OverlayRow key={o.key} k={o.key} label={o.label} />
      ))}
      {/* Horizontal divider between overlay toggles and LOD section */}
      <div style={{ borderTop: `1px solid ${COL.border}`, margin: '2px 0' }} />
      <LodSection />
    </div>
  )
}
