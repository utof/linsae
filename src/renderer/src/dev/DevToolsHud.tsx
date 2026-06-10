import { useState } from 'react'
import { useHotkeys } from 'react-hotkeys-hook'
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
    </div>
  )
}
