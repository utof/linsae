import { Link2, Pen, Trash2 } from 'lucide-react'
import { type MouseEvent, type ReactNode, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'

export interface ContextMenuPos {
  x: number
  y: number
}

/**
 * A single item in a {@link ContextMenuShell}.
 *
 * Why a plain data interface (not a render-prop): items-driven shells are
 * easier to compose and test — callers build an array rather than interpolating
 * JSX, and the shell owns all styling so menus look identical everywhere.
 */
export interface ContextMenuItem {
  key: string
  /** Visible label AND accessible name (aria-label, lowercased). */
  label: string
  icon: ReactNode
  onClick: () => void
  /** Renders in the destructive red (`var(--status-wtf)`), like Delete. */
  danger?: boolean
  /**
   * Single lowercase letter underlined in the label and bound as a plain-key
   * shortcut while the menu is open (e.g. `d` → Delete). The first
   * case-insensitive occurrence of the letter is underlined; pressing it runs
   * `onClick` then `onClose`. Letters must be unique within one menu.
   */
  mnemonic?: string
}

const mnemonicUnderline: React.CSSProperties = { textUnderlineOffset: 2 }

/**
 * Render a menu label with the first case-insensitive occurrence of `letter`
 * underlined (before / <u>letter</u> / after). No mnemonic → the plain label.
 * Why split on the real character (not always index 0): some labels don't
 * start with their mnemonic (e.g. "Select up to this note" → `u`), so the
 * underline must land on the actual letter the shortcut fires on.
 */
function renderMnemonicLabel(label: string, letter: string | undefined): ReactNode {
  if (!letter) return label
  const i = label.toLowerCase().indexOf(letter.toLowerCase())
  if (i === -1) return label
  return (
    <>
      {label.slice(0, i)}
      <u style={mnemonicUnderline}>{label.slice(i, i + 1)}</u>
      {label.slice(i + 1)}
    </>
  )
}

/**
 * True when a keyboard event originates inside an editable field, so the
 * context menu's global key shortcuts must yield. Why: a letter typed in
 * the composer must reach the textarea, never fire a menu mnemonic (mirrors
 * src/renderer/src/thread/ThreadView.tsx:349's reason for omitting `enableOnFormTags`).
 */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  const el = target as HTMLElement
  return el.closest('textarea, input, [contenteditable="true"]') != null
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
 * Generic right-click menu shell — portal to body (escapes the virtual-row
 * transform containing-block, see NoteContextMenu's portal rationale below),
 * fixed at viewport coords, Escape/outside-click to close, item hover tint.
 * NoteContextMenu and the Feed's selection menu both render through it so
 * right-click menus look and behave identically everywhere.
 *
 * Why items-driven (not render-prop): callers build a ContextMenuItem[] array,
 * the shell owns all DOM/styling — a single implementation point so a style
 * change lands in every menu simultaneously and tests can query by aria-label.
 *
 * @see src/renderer/src/feed/ContextMenu.tsx NoteContextMenu (portal rationale)
 */
export function ContextMenuShell({
  pos,
  items,
  onClose,
}: {
  pos: ContextMenuPos
  items: ContextMenuItem[]
  onClose: () => void
}) {
  const menuRef = useRef<HTMLDivElement | null>(null)

  // Close on Escape AND fire item mnemonics on a plain matching letter.
  // CAPTURE phase + stopImmediatePropagation: an open menu owns the keyboard.
  // Bubble-phase document listeners (SelectionBar's c/d, the Feed's nav layer,
  // the Feed's selection-Esc) must never see a key the menu handled — else a
  // single `d` would bulk-delete via the menu AND arm the bar, and Escape
  // would nuke the selection instead of just closing the menu (two-step Esc:
  // first closes the menu, second exits selection mode). Same modifier/typing
  // guards as the SelectionBar layer — a `d` typed in the composer must never
  // trigger a menu Delete.
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopImmediatePropagation()
        onClose()
        return
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (isTypingTarget(e.target)) return
      const hit = items.find((it) => it.mnemonic && it.mnemonic === e.key.toLowerCase())
      if (hit) {
        e.preventDefault()
        e.stopImmediatePropagation()
        hit.onClick()
        onClose()
      }
    }
    const handleMouseDown = (e: globalThis.MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose()
      }
    }
    document.addEventListener('keydown', handleKey, true)
    document.addEventListener('mousedown', handleMouseDown)
    return () => {
      document.removeEventListener('keydown', handleKey, true)
      document.removeEventListener('mousedown', handleMouseDown)
    }
  }, [onClose, items])

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
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          role="menuitem"
          // aria-label uses the label lowercased so existing accessible names
          // ('edit', 'copy link', 'delete') are preserved exactly — NoteBubble.test.tsx
          // queries them and the plan's CRITICAL note mandates this.
          // ONLY the visible children change to mnemonic-split render; the
          // accessible name stays stable so getByRole('menuitem', { name: … }) works.
          aria-label={item.label.toLowerCase()}
          style={item.danger ? { ...itemStyle, color: 'var(--status-wtf)' } : itemStyle}
          onClick={makeHandler(item.onClick)}
          onMouseEnter={hoverIn}
          onMouseLeave={hoverOut}
        >
          {item.icon}
          {renderMnemonicLabel(item.label, item.mnemonic)}
        </button>
      ))}
    </div>,
    document.body,
  )
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
  const items: ContextMenuItem[] = [
    ...(onEdit
      ? [{ key: 'edit', label: 'Edit', icon: <Pen size={14} />, onClick: onEdit, mnemonic: 'e' }]
      : []),
    {
      key: 'copy-link',
      label: 'Copy link',
      icon: <Link2 size={14} />,
      onClick: onCopyLink,
      mnemonic: 'c',
    },
    {
      key: 'delete',
      label: 'Delete',
      icon: <Trash2 size={14} />,
      onClick: onDelete,
      danger: true,
      mnemonic: 'd',
    },
  ]
  return <ContextMenuShell pos={pos} items={items} onClose={onClose} />
}
