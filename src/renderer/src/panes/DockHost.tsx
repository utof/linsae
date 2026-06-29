import { Dock } from './Dock'
import { type DockSide, dockWidthFor, useDockStore } from './dockStore'

interface DockHostProps {
  side: DockSide
  /** Close handler with App-owned side effects (clear pdf.openDocId / focusedId). */
  onPaneClose: (paneId: string) => void
}

/** Store connector for one dock side: renders <Dock> (or null when empty) and
 *  binds generic actions to the store; `onClose` delegates to App because some
 *  panes have side effects only App owns (spec §2, §4 C2/I1).
 *  @see docs/specs/v0.6.2-dock-shell.md §2 */
export function DockHost({ side, onPaneClose }: DockHostProps): React.JSX.Element | null {
  const slice = useDockStore((s) => s[side])
  const width = useDockStore((s) => {
    // The `0` is an unreachable placeholder: when there is no active pane this
    // component early-returns null below, so the width is never rendered.
    const a = s[side].activeId
    return a ? dockWidthFor(s, a) : 0
  })
  const setActive = useDockStore((s) => s.setActive)
  const setWidth = useDockStore((s) => s.setWidth)
  const activeId = slice.activeId
  if (!activeId) return null
  return (
    <Dock
      side={side}
      openPaneIds={slice.openPaneIds}
      activeId={activeId}
      width={width}
      onActivate={(id) => setActive(side, id)}
      onClose={onPaneClose}
      onWidthChange={(w) => setWidth(activeId, w)}
    />
  )
}
