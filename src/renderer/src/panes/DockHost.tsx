import { Dock } from './Dock'
import { type DockSide, dockWidthFor, useDockStore } from './dockStore'

interface DockHostProps {
  side: DockSide
  /** Close handler with App-owned side effects (clear pdf.openDocId / focusedId). */
  onPaneClose: (paneId: string) => void
  /**
   * Effective (window-capped) render width from App (B14). App owns the geometry
   * (it measures the window and knows both docks), so it caps the width so the
   * feed keeps ≥ FEED_BAND.min and the docks never overlap it. Omitted ⇒ fall back
   * to the per-side store width (standalone render / unit tests).
   */
  width?: number
  /**
   * Resize cap (B14): `onWidthChange` is clamped to this BEFORE the store clamps to
   * the kind band, so a drag can never store a width that would push the feed below
   * its minimum (no overlap, dock hard-capped). Omitted ⇒ no extra cap.
   */
  maxWidth?: number
}

/** Store connector for one dock side: renders <Dock> (or null when empty) and
 *  binds generic actions to the store; `onClose` delegates to App because some
 *  panes have side effects only App owns (spec §2, §4 C2/I1). Width + cap are
 *  supplied by App (B14 geometry owner) and fall back to the store when absent.
 *  @see docs/specs/v0.6.2-dock-shell.md §2
 *  @see adrs/0047-feed-default-width-docks-fill-gutters.md */
export function DockHost({
  side,
  onPaneClose,
  width: widthProp,
  maxWidth,
}: DockHostProps): React.JSX.Element | null {
  const slice = useDockStore((s) => s[side])
  const storeWidth = useDockStore((s) => (s[side].activeId ? dockWidthFor(s, side) : 0))
  const setActive = useDockStore((s) => s.setActive)
  const setWidth = useDockStore((s) => s.setWidth)
  const activeId = slice.activeId
  if (!activeId) return null
  const width = widthProp ?? storeWidth
  return (
    <Dock
      side={side}
      openPaneIds={slice.openPaneIds}
      activeId={activeId}
      width={width}
      onActivate={(id) => setActive(side, id)}
      onClose={onPaneClose}
      onWidthChange={(w) => setWidth(activeId, maxWidth != null ? Math.min(w, maxWidth) : w)}
    />
  )
}
