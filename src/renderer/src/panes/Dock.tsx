import { X } from 'lucide-react'
import { useCallback, useEffect, useRef } from 'react'
import { DockTabs } from './DockTabs'
import type { DockSide } from './dockStore'
import { getPane } from './Pane'

interface DockProps {
  side: DockSide
  openPaneIds: string[]
  activeId: string
  width: number
  onActivate: (paneId: string) => void
  onClose: (paneId: string) => void
  onWidthChange: (width: number) => void
}

/** Presentational dock: renders the active pane, a DockTabs strip at ≥2 panes,
 *  and an edge resize handle. Fully controlled — holds NO local width state; the
 *  store is the sole clamp site (spec §2). `side` mirrors chrome + resize.
 *  @see docs/specs/v0.6.2-dock-shell.md §2 */
export function Dock({
  side,
  openPaneIds,
  activeId,
  width,
  onActivate,
  onClose,
  onWidthChange,
}: DockProps): React.JSX.Element {
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null)
  // Latest-ref so the drag handlers below can have EMPTY deps and stay stable
  // across renders. `onWidthChange` is a fresh closure every DockHost render
  // (it captures the live activeId), and setWidth re-renders DockHost mid-drag;
  // if the handlers tracked `side`/`onWidthChange` in their deps, that identity
  // churn would change the unmount-safety effect's deps and run its cleanup —
  // tearing down the window listeners after the first pointermove. Reading from
  // the ref keeps the handlers stable so listeners survive the whole drag.
  const latest = useRef({ side, onWidthChange })
  latest.current = { side, onWidthChange }

  const onPointerMove = useCallback((e: PointerEvent) => {
    const drag = dragRef.current
    if (!drag) return
    // Right dock's handle is on the LEFT edge, so cursor-right shrinks it —
    // mirror of the left dock where cursor-right grows it.
    const { side, onWidthChange } = latest.current
    const delta = e.clientX - drag.startX
    onWidthChange(side === 'right' ? drag.startWidth - delta : drag.startWidth + delta)
  }, [])
  // Deps = [onPointerMove] only (it is stable → onPointerUp stays stable too);
  // the self-reference does not need listing. Stability is what keeps the
  // unmount effect from tearing down listeners mid-drag.
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
  // Unmount safety: if the Dock unmounts mid-drag the window listeners would
  // otherwise leak. Both callbacks are stable (empty deps) so this runs only on
  // real unmount — it does not tear down listeners mid-drag.
  useEffect(
    () => () => {
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
    },
    [onPointerMove, onPointerUp],
  )

  const active = getPane(activeId)
  const tabbed = openPaneIds.length >= 2

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
      {tabbed ? (
        <DockTabs
          paneIds={openPaneIds}
          activeId={activeId}
          onActivate={onActivate}
          onClose={onClose}
        />
      ) : (
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
          <span>{active?.title ?? activeId}</span>
          <button
            type="button"
            aria-label={`close ${active?.title ?? activeId}`}
            onClick={() => onClose(activeId)}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              border: 'none',
              background: 'transparent',
              color: 'var(--fg-2)',
              cursor: 'pointer',
              padding: 'var(--space-1)',
            }}
          >
            {/* Lucide X, matching DockTabs' close glyph (design's close icon). */}
            <X size={14} aria-hidden />
          </button>
        </header>
      )}
      <div style={{ flex: 1, overflow: 'auto' }}>{active?.render()}</div>
      {/* Intentionally pointer-only — keyboard resize (the WAI-ARIA
          role="separator" splitter pattern) is deferred to a later milestone,
          so no role/aria here yet. */}
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
