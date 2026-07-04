import { Minus, PanelLeft, PanelRight, Settings, Square, X } from 'lucide-react'
import { api } from '../lib/api'

interface Props {
  onOpenPalette: () => void
  onOpenSettings: () => void
  /** Active main view — drives the centered feed|canvas segmented control. */
  view: 'feed' | 'canvas'
  /** Switch the main view (mod+1 / mod+2 also drive this from App). */
  onViewChange: (v: 'feed' | 'canvas') => void
  /** Whether the left dock (shelf) is open — drives the toggle's pressed state. */
  dockOpen: boolean
  /** Toggle the left dock open/closed (the §10 quiet outline toggle). */
  onToggleDock: () => void
  /** Whether the backlinks dock pane is open — drives the backlinks toggle's pressed state (B2). */
  backlinksOpen: boolean
  /** Toggle the backlinks dock pane open/closed, independent of focusing a note (B2). */
  onToggleBacklinks: () => void
}

/**
 * Custom frameless-window chrome. Lives at the top of the App, drives
 * window-drag via -webkit-app-region (CSS utility classes in globals.css)
 * and exposes the only persistent right-cluster controls: ⌘K palette pill,
 * `reveal notes` shortcut, and the OS-standard min / max-toggle / close
 * triplet.
 *
 * Why custom (not the OS title bar): the user explicitly asked to remove
 * the three stacked chrome strips (OS title bar + Electron menu bar +
 * renderer Topbar) — main now sets `frame: false` and `autoHideMenuBar:
 * true`, leaving this strip as the only chrome. The bar is intentionally
 * background-blended (no border, no fill) so visually it reads as part of
 * the feed area; only the cluster on the right shows controls.
 *
 * Why ⌘K + reveal-notes live here (not in the composer): they're chrome,
 * not authoring affordances — they belong with min/max/close. The composer
 * stays focused on text input.
 *
 * Why the close button red-tints on hover (and not min/max): matches the OS
 * convention universally — users expect close to be the "destructive" of
 * the three. Min/max stay neutral.
 *
 * @see src/main/index.ts (frame: false, autoHideMenuBar: true)
 * @see src/main/ipc/system.ts (windowMinimize / windowToggleMaximize / windowClose)
 * @see src/renderer/src/styles/globals.css (.app-region-drag / .app-region-no-drag)
 */
export function WindowFrame({
  onOpenPalette,
  onOpenSettings,
  view,
  onViewChange,
  dockOpen,
  onToggleDock,
  backlinksOpen,
  onToggleBacklinks,
}: Props) {
  // Quiet segmented control — text-only (no icons, v21 restraint). Active pill
  // reads --fg-0 on --bg-2; inactive sits at --fg-3. Ships UNANIMATED (ADR 0019:
  // the Feed|Canvas slide transition is Plan 3's, not this task's).
  const segBtn = (active: boolean) =>
    ({
      border: 0,
      borderRadius: 4,
      padding: '3px 10px',
      fontFamily: 'var(--font-sans)',
      fontSize: 11,
      cursor: 'pointer',
      background: active ? 'var(--bg-2)' : 'transparent',
      color: active ? 'var(--fg-0)' : 'var(--fg-3)',
    }) as const

  const iconBtn = {
    width: 28,
    height: 22,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    border: 0,
    background: 'transparent',
    color: 'var(--fg-2)',
    cursor: 'pointer',
    borderRadius: 4,
  } as const

  return (
    <div
      className="app-region-drag"
      style={{
        flex: '0 0 auto',
        height: 32,
        display: 'flex',
        alignItems: 'center',
        // space-between holds the left cluster (shelf toggle) at the left edge and
        // the right cluster at the right; the feed|canvas control is absolute-centered.
        justifyContent: 'space-between',
        padding: '0 6px 0 12px',
        background: 'transparent',
        fontFamily: 'var(--font-sans)',
        position: 'relative',
      }}
    >
      {/* Left cluster — the left-dock (shelf) toggle, pulled to the top-LEFT of the
          frame (it used to sit in the right cluster). app-region-no-drag so the click
          lands over the surrounding drag region; main uses frame:false so no OS
          traffic-lights occupy this corner, and the 12px inset clears the edge. */}
      <div className="app-region-no-drag" style={{ display: 'flex', alignItems: 'center' }}>
        {/* §10 dock toggle — one quiet outline button, no rail. aria-pressed
            reflects dockOpen so the quiet state is assertable. */}
        <button
          type="button"
          aria-label="toggle shelf"
          title="toggle shelf"
          aria-pressed={dockOpen}
          onClick={onToggleDock}
          style={{
            ...iconBtn,
            background: dockOpen ? 'var(--bg-2)' : 'transparent',
            color: dockOpen ? 'var(--fg-0)' : 'var(--fg-2)',
          }}
          onMouseEnter={(e) => {
            ;(e.currentTarget as HTMLButtonElement).style.background = 'var(--bg-2)'
          }}
          onMouseLeave={(e) => {
            ;(e.currentTarget as HTMLButtonElement).style.background = dockOpen
              ? 'var(--bg-2)'
              : 'transparent'
          }}
        >
          <PanelLeft size={14} />
        </button>
      </div>
      {/* Centered feed|canvas toggle — absolute so it stays centered regardless
          of the right cluster's width. app-region-no-drag so clicks register. */}
      <div
        className="app-region-no-drag"
        style={{
          position: 'absolute',
          left: '50%',
          top: '50%',
          transform: 'translate(-50%, -50%)',
          display: 'flex',
          alignItems: 'center',
          gap: 2,
        }}
      >
        <button
          type="button"
          aria-label="feed view"
          aria-pressed={view === 'feed'}
          onClick={() => onViewChange('feed')}
          style={segBtn(view === 'feed')}
        >
          feed
        </button>
        <button
          type="button"
          aria-label="canvas view"
          aria-pressed={view === 'canvas'}
          onClick={() => onViewChange('canvas')}
          style={segBtn(view === 'canvas')}
        >
          canvas
        </button>
      </div>
      <div
        className="app-region-no-drag"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          fontSize: 11,
          color: 'var(--fg-3)',
        }}
      >
        {/* B2 backlinks toggle — mirrors the shelf toggle for the right dock. A
            visible, always-reachable affordance to open/close backlinks
            independent of focusing a note. aria-pressed reflects backlinksOpen. */}
        <button
          type="button"
          aria-label="toggle backlinks"
          title="toggle backlinks"
          aria-pressed={backlinksOpen}
          onClick={onToggleBacklinks}
          style={{
            ...iconBtn,
            background: backlinksOpen ? 'var(--bg-2)' : 'transparent',
            color: backlinksOpen ? 'var(--fg-0)' : 'var(--fg-2)',
          }}
          onMouseEnter={(e) => {
            ;(e.currentTarget as HTMLButtonElement).style.background = 'var(--bg-2)'
          }}
          onMouseLeave={(e) => {
            ;(e.currentTarget as HTMLButtonElement).style.background = backlinksOpen
              ? 'var(--bg-2)'
              : 'transparent'
          }}
        >
          <PanelRight size={14} />
        </button>
        <button
          type="button"
          onClick={onOpenPalette}
          aria-label="open command palette"
          style={{
            background: 'var(--bg-2)',
            border: 0,
            borderRadius: 4,
            padding: '3px 8px',
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            cursor: 'pointer',
            color: 'var(--fg-2)',
          }}
        >
          ⌘K
        </button>
        <button
          type="button"
          onClick={onOpenSettings}
          aria-label="settings"
          title="settings"
          style={iconBtn}
          onMouseEnter={(e) => {
            ;(e.currentTarget as HTMLButtonElement).style.background = 'var(--bg-2)'
          }}
          onMouseLeave={(e) => {
            ;(e.currentTarget as HTMLButtonElement).style.background = 'transparent'
          }}
        >
          <Settings size={14} />
        </button>
        <button
          type="button"
          onClick={() => {
            void api.system.revealNotesFolder()
          }}
          title="reveal notes folder"
          aria-label="reveal notes folder"
          style={{
            background: 'transparent',
            border: 0,
            cursor: 'pointer',
            color: 'var(--fg-2)',
            fontSize: 12,
            padding: '2px 6px',
          }}
        >
          reveal notes
        </button>
        <div style={{ width: 8 }} />
        <button
          type="button"
          aria-label="minimize"
          title="minimize"
          onClick={() => {
            void api.system.window.minimize()
          }}
          style={iconBtn}
          onMouseEnter={(e) => {
            ;(e.currentTarget as HTMLButtonElement).style.background = 'var(--bg-2)'
          }}
          onMouseLeave={(e) => {
            ;(e.currentTarget as HTMLButtonElement).style.background = 'transparent'
          }}
        >
          <Minus size={14} />
        </button>
        <button
          type="button"
          aria-label="maximize"
          title="maximize / restore"
          onClick={() => {
            void api.system.window.toggleMaximize()
          }}
          style={iconBtn}
          onMouseEnter={(e) => {
            ;(e.currentTarget as HTMLButtonElement).style.background = 'var(--bg-2)'
          }}
          onMouseLeave={(e) => {
            ;(e.currentTarget as HTMLButtonElement).style.background = 'transparent'
          }}
        >
          <Square size={12} />
        </button>
        <button
          type="button"
          aria-label="close"
          title="close"
          onClick={() => {
            void api.system.window.close()
          }}
          style={iconBtn}
          onMouseEnter={(e) => {
            const el = e.currentTarget as HTMLButtonElement
            el.style.background = 'var(--status-wtf)'
            el.style.color = '#fff'
          }}
          onMouseLeave={(e) => {
            const el = e.currentTarget as HTMLButtonElement
            el.style.background = 'transparent'
            el.style.color = 'var(--fg-2)'
          }}
        >
          <X size={14} />
        </button>
      </div>
    </div>
  )
}
