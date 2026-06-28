import { useCallback, useEffect, useRef, useState } from 'react'
import { getPane } from './Pane'

/**
 * Kind-derived dock width bounds (px). Utility panes keep the original §10
 * 220–400 band; content panes (a PDF reader) get a wider 400–900 band so the
 * page is legible without dwarfing the stage.
 * @see docs/plans/v0.6-pdf-slim-slice.md §Task 7
 */
const MIN_WIDTH_UTILITY = 220
const MAX_WIDTH_UTILITY = 400
const DEFAULT_WIDTH_UTILITY = 280
const MIN_WIDTH_CONTENT = 400
const MAX_WIDTH_CONTENT = 900
const DEFAULT_WIDTH_CONTENT = 600

interface DockProps {
  open: boolean
  paneId: string
  onClose: () => void
  /**
   * Which screen edge the dock anchors to. Defaults to `'left'` (the v0.4
   * behavior): border + resize handle on the right edge, width grows rightward.
   * `'right'` mirrors all three so a right dock reads/resizes symmetrically.
   */
  side?: 'left' | 'right'
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
 * the in-memory width is clamped per the pane's {@link Pane.kind} on each
 * pointer-move frame. `side` (default `'left'`) mirrors the chrome + resize
 * direction for a right-anchored dock.
 * @see docs/specs/v0.4-canvas-mvp.md §10
 * @see docs/plans/v0.6-pdf-slim-slice.md §Task 7
 * @see docs/canvas-vision.md §Dock shell
 */
export function Dock({
  open,
  paneId,
  onClose,
  side = 'left',
}: DockProps): React.JSX.Element | null {
  // Kind-derive the clamp before the hooks (getPane is a pure lookup, not a
  // hook) so the initial width matches the pane's band. Default kind is
  // 'utility', preserving the v0.4 220/280/400 numbers for the Shelf.
  const pane = getPane(paneId)
  const isContent = pane?.kind === 'content'
  const MIN_WIDTH = isContent ? MIN_WIDTH_CONTENT : MIN_WIDTH_UTILITY
  const MAX_WIDTH = isContent ? MAX_WIDTH_CONTENT : MAX_WIDTH_UTILITY
  const DEFAULT_WIDTH = isContent ? DEFAULT_WIDTH_CONTENT : DEFAULT_WIDTH_UTILITY

  const [width, setWidth] = useState(DEFAULT_WIDTH)
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null)

  const onPointerMove = useCallback(
    (e: PointerEvent) => {
      const drag = dragRef.current
      if (!drag) return
      // Right dock's handle is on the LEFT edge, so cursor-right shrinks it —
      // mirror of the left dock where cursor-right grows it.
      const delta = e.clientX - drag.startX
      const next = side === 'right' ? drag.startWidth - delta : drag.startWidth + delta
      setWidth(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, next)))
    },
    [side, MIN_WIDTH, MAX_WIDTH],
  )

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

  // Unmount safety: if the Dock unmounts mid-drag (e.g. onClose swaps the
  // stage), window listeners would otherwise leak and call setWidth on an
  // unmounted component. Both callbacks are stable (useCallback) so this runs
  // only on real unmount — it does not tear down listeners mid-drag.
  useEffect(() => {
    return () => {
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
    }
  }, [onPointerMove, onPointerUp])

  if (!open) return null
  if (!pane) return null

  return (
    <aside
      data-dock={side}
      style={{
        position: 'relative',
        width,
        flex: `0 0 ${width}px`,
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--bg-1)',
        // Border on the inner edge: right dock borders left, left dock borders right.
        ...(side === 'right'
          ? { borderLeft: '1px solid var(--border-0)' }
          : { borderRight: '1px solid var(--border-0)' }),
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
      {/* Intentionally pointer-only — keyboard resize (the WAI-ARIA
          role="separator" splitter pattern) is deferred to the dock-shell
          milestone (vision §Dock shell), so no role/aria here yet. */}
      <div
        data-dock-resize
        onPointerDown={onResizeStart}
        style={{
          position: 'absolute',
          top: 0,
          // Handle straddles the inner edge — left for a right dock, right otherwise.
          ...(side === 'right' ? { left: -3 } : { right: -3 }),
          width: 6,
          height: '100%',
          cursor: 'col-resize',
        }}
      />
    </aside>
  )
}
