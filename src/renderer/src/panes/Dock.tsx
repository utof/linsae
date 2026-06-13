import { useCallback, useRef, useState } from 'react'
import { getPane } from './Pane'

/** Dock width bounds (spec §10 — resizable 220–400 px by edge drag). */
const MIN_WIDTH = 220
const MAX_WIDTH = 400
const DEFAULT_WIDTH = 280

interface DockProps {
  open: boolean
  paneId: string
  onClose: () => void
}

/**
 * The §10 embryo dock shell: a fixed-side, edge-resizable container rendering
 * exactly ONE pane (resolved via {@link getPane}). One pane ⇒ no tab strip —
 * just a quiet header (pane title + close ×) above the pane body. Open/closed
 * and width are in-memory view-state (not persisted in v0.4). The full grammar
 * (right dock, tab strips at ≥2 panes, tab dragging) is the vision §Dock shell
 * milestone — the registry stays data-driven so this grows without a rewrite.
 *
 * Resize precision is harness-verified later (happy-dom has no layout model);
 * the in-memory width is clamped to [220, 400] px on each pointer-move frame.
 * @see docs/specs/v0.4-canvas-mvp.md §10
 * @see docs/canvas-vision.md §Dock shell
 */
export function Dock({ open, paneId, onClose }: DockProps): React.JSX.Element | null {
  const [width, setWidth] = useState(DEFAULT_WIDTH)
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null)

  const onPointerMove = useCallback((e: PointerEvent) => {
    const drag = dragRef.current
    if (!drag) return
    const next = drag.startWidth + (e.clientX - drag.startX)
    setWidth(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, next)))
  }, [])

  const onPointerUp = useCallback(() => {
    dragRef.current = null
    window.removeEventListener('pointermove', onPointerMove)
    window.removeEventListener('pointerup', onPointerUp)
  }, [onPointerMove])

  const onResizeStart = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault()
      dragRef.current = { startX: e.clientX, startWidth: width }
      window.addEventListener('pointermove', onPointerMove)
      window.addEventListener('pointerup', onPointerUp)
    },
    [width, onPointerMove, onPointerUp],
  )

  if (!open) return null
  const pane = getPane(paneId)
  if (!pane) return null

  return (
    <aside
      data-dock="left"
      style={{
        position: 'relative',
        width,
        flex: `0 0 ${width}px`,
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--bg-1)',
        borderRight: '1px solid var(--border-0)',
      }}
    >
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          height: 'var(--topbar-h)',
          padding: '0 var(--space-4)',
          borderBottom: '1px solid var(--border-0)',
          fontSize: 'var(--t-13)',
          color: 'var(--fg-2)',
        }}
      >
        <span>{pane.title}</span>
        <button
          type="button"
          aria-label={`close ${pane.title}`}
          onClick={onClose}
          style={{
            border: 'none',
            background: 'transparent',
            color: 'var(--fg-2)',
            cursor: 'pointer',
            fontSize: 'var(--t-16)',
            lineHeight: 1,
            padding: 'var(--space-1)',
          }}
        >
          ×
        </button>
      </header>
      <div style={{ flex: 1, overflow: 'auto' }}>{pane.render()}</div>
      <div
        data-dock-resize
        onPointerDown={onResizeStart}
        style={{
          position: 'absolute',
          top: 0,
          right: -3,
          width: 6,
          height: '100%',
          cursor: 'col-resize',
        }}
      />
    </aside>
  )
}
