import { Link2, Pen, Trash2 } from 'lucide-react'
import { type MouseEvent, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'

export interface ContextMenuPos {
  x: number
  y: number
}

export interface NoteContextMenuProps {
  pos: ContextMenuPos
  onCopyLink: () => void
  onDelete: () => void
  onClose: () => void
  /**
   * Edit item — omitted for source/video cards, which have no editable body
   * (you annotate inside the thread, not on the card).
   */
  onEdit?: () => void
}

/**
 * Shared right-click menu for feed items — text bubbles (NoteBubble) AND video
 * cards (MediaFeedNote). One implementation so right-click behaves identically
 * everywhere (the "universality" the design calls for).
 *
 * Why custom React (not native Electron Menu.popup via IPC): testable in jsdom
 * without a new IPC channel, matches the v21 inline-style aesthetic, and avoids
 * the async round-trip that would prevent synchronous callback assertions in RTL.
 *
 * Why single-click delete (no arm pattern): the labeled menu item is itself the
 * confirmation surface — the user explicitly chose "Delete" from a named list,
 * unlike the hover toolbar where the trash icon sits 14px from copy-link.
 *
 * Rendered into document.body via a portal. CRITICAL: the menu is `position: fixed`
 * with viewport coords (clientX/clientY), but every feed item is rendered inside a
 * `transform: translateY(...)` virtual-item wrapper (Feed.tsx) — and a transformed
 * ancestor becomes the containing block for fixed descendants, so an inline menu was
 * offset by the wrapper's scroll-dependent translate (drifted up, eventually off-screen).
 * Portaling to body removes the menu from that transformed subtree so `fixed` resolves
 * to the viewport again. Regressed when the feed moved to @tanstack/react-virtual (65e5ce8).
 * Click-outside still works: React events bubble through the React tree, and the
 * `menuRef.contains` check is on the portaled node itself.
 *
 * @see https://developer.mozilla.org/en-US/docs/Web/CSS/position#fixed
 * @see docs/specs/v0.1-rolling-feed-and-search.md §Feed bubble
 */
export function NoteContextMenu({
  pos,
  onEdit,
  onCopyLink,
  onDelete,
  onClose,
}: NoteContextMenuProps) {
  const menuRef = useRef<HTMLDivElement | null>(null)

  // Close on Escape key and mousedown-outside via document listeners.
  // Why document-level (not window): document captures events before window in
  // the bubbling phase, matching the expected "click outside" contract in jsdom.
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    const handleMouseDown = (e: globalThis.MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose()
      }
    }
    document.addEventListener('keydown', handleKey)
    document.addEventListener('mousedown', handleMouseDown)
    return () => {
      document.removeEventListener('keydown', handleKey)
      document.removeEventListener('mousedown', handleMouseDown)
    }
  }, [onClose])

  const itemStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    width: '100%',
    padding: '6px 12px',
    fontSize: 13,
    fontFamily: 'var(--font-sans)',
    color: 'var(--fg-0)',
    border: 0,
    background: 'transparent',
    cursor: 'pointer',
    textAlign: 'left',
    borderRadius: 2,
  }

  const makeHandler = (cb: () => void) => (e: MouseEvent) => {
    e.stopPropagation()
    cb()
    onClose()
  }
  const hoverIn = (e: MouseEvent) => {
    ;(e.currentTarget as HTMLButtonElement).style.background = 'var(--bg-3)'
  }
  const hoverOut = (e: MouseEvent) => {
    ;(e.currentTarget as HTMLButtonElement).style.background = 'transparent'
  }

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      style={{
        position: 'fixed',
        top: pos.y,
        left: pos.x,
        zIndex: 1000,
        background: '#fff',
        border: '1px solid var(--border-1)',
        borderRadius: 4,
        padding: 4,
        boxShadow: 'var(--shadow-1)',
        minWidth: 140,
      }}
    >
      {onEdit && (
        <button
          type="button"
          role="menuitem"
          aria-label="edit"
          style={itemStyle}
          onClick={makeHandler(onEdit)}
          onMouseEnter={hoverIn}
          onMouseLeave={hoverOut}
        >
          <Pen size={14} />
          Edit
        </button>
      )}
      <button
        type="button"
        role="menuitem"
        aria-label="copy link"
        style={itemStyle}
        onClick={makeHandler(onCopyLink)}
        onMouseEnter={hoverIn}
        onMouseLeave={hoverOut}
      >
        <Link2 size={14} />
        Copy link
      </button>
      <button
        type="button"
        role="menuitem"
        aria-label="delete"
        style={{ ...itemStyle, color: 'var(--status-wtf)' }}
        onClick={makeHandler(onDelete)}
        onMouseEnter={hoverIn}
        onMouseLeave={hoverOut}
      >
        <Trash2 size={14} />
        Delete
      </button>
    </div>,
    document.body,
  )
}
