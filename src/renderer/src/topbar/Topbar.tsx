import { api } from '../lib/api'

interface Props {
  onOpenPalette: () => void
}

/**
 * Fixed-height (44 px) top bar pinned above the feed. Left: app wordmark
 * `linsae` (Geist 500, 14 px). Right cluster: a `⌘K` key-cap pill and a
 * `reveal notes` text button that opens the on-disk notes directory via
 * `shell.openPath` (wired through `api.system.revealNotesFolder()`).
 *
 * Why the ⌘K pill is a real `<button>` (not just a decorative `KBD`):
 * mouse-only users who don't know the keyboard shortcut still need an
 * affordance to open the palette. Making it `onClick`-able fuses the
 * "shortcut hint" and the "click target" into a single discoverable
 * surface — same approach Linear/Tana take in the v21 prototype at
 * `v21-design-system/project/ui_kits/v21-app/topbar.jsx`.
 *
 * @see docs/specs/v0.1-rolling-feed-and-search.md §Topbar
 * @see docs/plans/v0.1-rolling-feed-and-search.md §Task 29
 * @see v21-design-system/project/ui_kits/v21-app/topbar.jsx
 */
export function Topbar({ onOpenPalette }: Props) {
  return (
    <div
      style={{
        flex: '0 0 auto',
        height: 44,
        padding: '0 16px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        borderBottom: '1px solid var(--border-0)',
        background: '#fff',
        fontFamily: 'var(--font-sans)',
      }}
    >
      <div style={{ fontWeight: 500, fontSize: 14, color: 'var(--fg-0)' }}>linsae</div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
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
            padding: '4px 8px',
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
          onClick={() => api.system.revealNotesFolder()}
          title="reveal notes folder"
          aria-label="reveal notes folder"
          style={{
            background: 'transparent',
            border: 0,
            cursor: 'pointer',
            color: 'var(--fg-2)',
            fontSize: 12,
          }}
        >
          reveal notes
        </button>
      </div>
    </div>
  )
}
