import { Minus, Square, X } from 'lucide-react'
import { api } from '../lib/api'

interface Props {
  onOpenPalette: () => void
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
export function WindowFrame({ onOpenPalette }: Props) {
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
        justifyContent: 'flex-end',
        padding: '0 6px 0 12px',
        background: 'transparent',
        fontFamily: 'var(--font-sans)',
      }}
    >
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
