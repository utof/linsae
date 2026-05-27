import { ChevronDown, Link2, Pen, Trash2 } from 'lucide-react'
import { type MouseEvent, useEffect, useRef, useState } from 'react'
import type { Note } from '../../../shared/types'
import { Markdown } from '../lib/markdown'

interface ContextMenuPos {
  x: number
  y: number
}

/**
 * Floating context menu shown on right-click of a NoteBubble.
 *
 * Why custom React (not native Electron Menu.popup via IPC): testable in jsdom
 * without a new IPC channel, matches the v21 inline-style aesthetic, and avoids
 * the async round-trip that would prevent synchronous callback assertions in RTL.
 *
 * Why single-click delete (no arm pattern): the labeled menu item is itself the
 * confirmation surface — the user explicitly chose "Delete" from a named list,
 * unlike the hover toolbar where the trash icon is 14px next to copy-link.
 *
 * Why right-click does NOT also fire onFocus: this app wires `focusedId` to
 * the BacklinksPane's visibility (App.tsx), so opening a context menu would
 * silently open the backlinks panel as a side-effect. The menu's actions
 * capture bubble identity via closure, so selection is implicit anyway.
 *
 * @see docs/specs/v0.1-rolling-feed-and-search.md §Feed bubble
 */
function BubbleContextMenu({
  pos,
  onEdit,
  onCopyLink,
  onDelete,
  onClose,
}: {
  pos: ContextMenuPos
  onEdit: () => void
  onCopyLink: () => void
  onDelete: () => void
  onClose: () => void
}) {
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

  return (
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
      <button
        type="button"
        role="menuitem"
        aria-label="edit"
        style={itemStyle}
        onClick={makeHandler(onEdit)}
        onMouseEnter={(e) => {
          ;(e.currentTarget as HTMLButtonElement).style.background = 'var(--bg-3)'
        }}
        onMouseLeave={(e) => {
          ;(e.currentTarget as HTMLButtonElement).style.background = 'transparent'
        }}
      >
        <Pen size={14} />
        Edit
      </button>
      <button
        type="button"
        role="menuitem"
        aria-label="copy link"
        style={itemStyle}
        onClick={makeHandler(onCopyLink)}
        onMouseEnter={(e) => {
          ;(e.currentTarget as HTMLButtonElement).style.background = 'var(--bg-3)'
        }}
        onMouseLeave={(e) => {
          ;(e.currentTarget as HTMLButtonElement).style.background = 'transparent'
        }}
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
        onMouseEnter={(e) => {
          ;(e.currentTarget as HTMLButtonElement).style.background = 'var(--bg-3)'
        }}
        onMouseLeave={(e) => {
          ;(e.currentTarget as HTMLButtonElement).style.background = 'transparent'
        }}
      >
        <Trash2 size={14} />
        Delete
      </button>
    </div>
  )
}

/**
 * Hard cap on the rendered body length before the fade-out + expand
 * affordance kicks in. 4096 is a "data-structure nice" power-of-two
 * round number chosen by the user — large enough that essentially no
 * normal note bumps into it, small enough that one bubble rendering a
 * pasted 10k-char log doesn't dominate the feed's visual rhythm.
 */
const BODY_TRUNCATE_AT = 4096

/**
 * Telegram-style timestamp for the bubble footer.
 *
 * Today → just the time ("14:23" or "2:23 PM" depending on OS locale).
 * Older → month-day prefix ("May 27, 2:23 PM") so a bubble from days ago
 * isn't ambiguous with one from this morning. linsae has no day-separator
 * row (unlike Telegram) so the bubble itself must carry the date for
 * non-today entries.
 */
function formatTimestamp(ms: number): string {
  const d = new Date(ms)
  const now = new Date()
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  return sameDay
    ? d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      })
}

interface Props {
  note: Note
  focused: boolean
  onFocus: () => void
  onWikilinkClick: (slug: string) => void
  resolveSlug?: (slug: string) => boolean
  onEdit: () => void
  onDelete: () => void
  onCopyLink: () => void
}

/**
 * Renders a single Note as a Telegram-style chat bubble in the feed.
 *
 * Variants:
 *  - `claim` (default): pure white background, neutral hairline border.
 *  - `question`: amber-tint `#FFFBF0` background, `#FAEAC2` border, body in
 *    Newsreader italic at 16px (spec §Feed bubble).
 *  - `focused`: 2px accent rail (`#0D99FF`) on the left edge, `var(--bg-3)`
 *    background — matches v21's selected-row state.
 *
 * The hover action bar (edit / copy-link / delete) is rendered only while
 * hover state is true; its click handlers stop propagation so the underlying
 * bubble's `onFocus` doesn't double-fire.
 *
 * Why the 2-second-confirm delete (first click arms a red highlight, second
 * click within 2 s fires `onDelete`): deletion is destructive and the trash
 * icon sits 14 px from copy-link — accidental misclick is plausible. The
 * red-tint armed state surfaces intent before destruction. A timeout resets
 * the armed state so a stale arm can't bite the user on their next visit.
 *
 * Why hover-only action bar (vs always-visible): keeps the feed visually quiet
 * — the bubble's content is the focus, not the controls. Matches the v21
 * prototype at `v21-design-system/project/ui_kits/v21-app/feed.jsx`.
 *
 * @see docs/specs/v0.1-rolling-feed-and-search.md §Feed bubble
 * @see v21-design-system/project/ui_kits/v21-app/feed.jsx
 */
export function NoteBubble({
  note,
  focused,
  onFocus,
  onWikilinkClick,
  resolveSlug,
  onEdit,
  onDelete,
  onCopyLink,
}: Props) {
  const [hover, setHover] = useState(false)
  const [deleteArmed, setDeleteArmed] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [contextMenu, setContextMenu] = useState<ContextMenuPos | null>(null)
  // window.setTimeout returns number in renderer (DOM lib); Node's setTimeout
  // returns NodeJS.Timeout. Tests run in jsdom — the number variant is correct.
  const armTimer = useRef<number | null>(null)

  const handleContextMenu = (e: MouseEvent) => {
    e.preventDefault()
    // Why we do NOT call onFocus here: in this app, focusing a bubble opens
    // the BacklinksPane (App.tsx wires focusedId → pane visibility). Opening
    // a context menu shouldn't also open backlinks — the menu's actions
    // already capture the bubble's identity via closure, so selection is
    // implicit.
    setContextMenu({ x: e.clientX, y: e.clientY })
  }

  const isQuestion = note.type === 'question'
  const bg = focused ? 'var(--bg-3)' : isQuestion ? '#FFFBF0' : '#FFFFFF'
  // border-1 (one step up from v21 feed.jsx:122's `--border-0` hairline) —
  // bubble-to-bubble separation was too subtle at the lightest tier; the
  // default tier reads as a clearer card boundary without becoming a heavy
  // chrome line. Question bubbles keep their amber `#FAEAC2` for type-tint.
  const border = isQuestion ? '#FAEAC2' : 'var(--border-1)'

  // Truncate display body at BODY_TRUNCATE_AT chars and surface an expand
  // affordance when the user hasn't expanded yet. Word count uses the FULL
  // body so the affordance shows the cost of expansion ("expand (3.2k
  // words)"). split(/\s+/) on a trimmed string is fine for word-counting
  // English-ish prose at v0.1; CJK and other scripts will under-count
  // (tracked as nit, not blocking).
  const overCap = note.body.length > BODY_TRUNCATE_AT
  const rawDisplayBody = overCap && !expanded ? note.body.slice(0, BODY_TRUNCATE_AT) : note.body
  const wordCount = overCap ? note.body.trim().split(/\s+/).length : 0

  // Telegram-style "time floats inline with the last line of text" trick:
  // append a run of non-breaking spaces to the body so the last paragraph's
  // last line reserves enough horizontal width for the absolute-positioned
  // time + edited pen to sit at its end. If the reservation pushes the line
  // past the bubble width, the nbsps wrap to a new line and the absolutely-
  // positioned time still sits in the bottom-right corner. Only applied when
  // there is no expand button — when overCap is true the bottom flex row is
  // already used by the expand control + time, so the floating trick isn't
  // needed there. ~12 nbsps ≈ 70-85px depending on font, covers the time
  // (~50px) + edited icon (~14px) + small gap.
  const TIME_RESERVATION = '\u00A0'.repeat(12)
  const displayBody = overCap ? rawDisplayBody : `${rawDisplayBody}${TIME_RESERVATION}`

  const handleTrashClick = (e: MouseEvent) => {
    e.stopPropagation()
    if (deleteArmed) {
      if (armTimer.current !== null) clearTimeout(armTimer.current)
      setDeleteArmed(false)
      onDelete()
      return
    }
    setDeleteArmed(true)
    armTimer.current = window.setTimeout(() => setDeleteArmed(false), 2000)
  }

  // Clear the arm timer on unmount so a pending setTimeout doesn't fire
  // setState on a virtualised-out bubble (Feed uses react-virtuoso).
  useEffect(
    () => () => {
      if (armTimer.current !== null) clearTimeout(armTimer.current)
    },
    [],
  )

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: bubble is a click target for focus selection; keyboard nav lives on Composer / palette per spec.
    // biome-ignore lint/a11y/useKeyWithClickEvents: focus selection is mouse-only at v0.1 (see spec §Keyboard — no E shortcut for bubble selection).
    <div
      data-bubble
      onClick={onFocus}
      onContextMenu={handleContextMenu}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        position: 'relative',
        background: bg,
        border: `1px solid ${border}`,
        borderLeft: focused ? '2px solid #0D99FF' : `1px solid ${border}`,
        borderRadius: 14,
        padding: '6px 12px',
        margin: '6px 0',
        maxWidth: 560,
        fontFamily: isQuestion ? 'var(--font-serif)' : 'var(--font-sans)',
        fontStyle: isQuestion ? 'italic' : 'normal',
        fontSize: isQuestion ? 16 : 14,
        color: 'var(--fg-0)',
        cursor: 'pointer',
        // Let long unbroken tokens (URLs, no-space pastes) break inside the
        // bubble instead of clipping past the right edge. `anywhere` is
        // more aggressive than `break-word` — it breaks at any character
        // before content overflows, matching the v21 "card grows vertically
        // to fit text" aesthetic.
        overflowWrap: 'anywhere',
      }}
    >
      {overCap && !expanded ? (
        // Wrapper is positioned so the fade-out overlay can absolutely-
        // position over the bottom of the truncated markdown. pointer-events
        // none on the overlay so clicks pass through to the bubble below.
        <div style={{ position: 'relative' }}>
          <Markdown
            body={displayBody}
            onWikilinkClick={onWikilinkClick}
            {...(resolveSlug ? { resolveSlug } : {})}
          />
          <div
            aria-hidden
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              bottom: 0,
              height: 56,
              background: `linear-gradient(to bottom, transparent, ${bg})`,
              pointerEvents: 'none',
            }}
          />
        </div>
      ) : (
        <Markdown
          body={displayBody}
          onWikilinkClick={onWikilinkClick}
          {...(resolveSlug ? { resolveSlug } : {})}
        />
      )}

      {/* Bottom row when overCap: expand button on the left, time on the right.
         The flex row anchors the expand button to the same baseline as the
         time; it cannot use the floating-time trick because the expand
         control needs to be a real layout element. */}
      {overCap && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 8,
            marginTop: 2,
            color: 'var(--fg-3)',
            fontFamily: 'var(--font-sans)',
            fontSize: 11,
            fontStyle: 'normal',
            lineHeight: 1,
          }}
        >
          <button
            type="button"
            aria-label={expanded ? 'collapse note' : `expand note — ${wordCount} words`}
            onClick={(e) => {
              e.stopPropagation()
              setExpanded((v) => !v)
            }}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              border: 0,
              background: 'transparent',
              color: 'var(--fg-2)',
              fontFamily: 'inherit',
              fontSize: 'inherit',
              cursor: 'pointer',
              padding: 0,
            }}
          >
            <ChevronDown
              size={12}
              style={{
                transform: expanded ? 'rotate(180deg)' : 'none',
                transition: 'transform 120ms ease',
              }}
            />
            {expanded ? 'collapse' : `expand (${wordCount.toLocaleString()} words)`}
          </button>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            {note.updated_at > note.created_at && (
              <span
                role="img"
                aria-label="edited"
                title={`edited ${new Date(note.updated_at).toLocaleString()}`}
                style={{ display: 'inline-flex' }}
              >
                <Pen size={10} />
              </span>
            )}
            <span title={new Date(note.created_at).toLocaleString()}>
              {formatTimestamp(note.created_at)}
            </span>
          </span>
        </div>
      )}

      {/* When not overCap: absolutely position the time over the trailing
         nbsps appended to the markdown body. If the last line has room,
         the time floats inline at the end; if the last line wraps, the
         nbsps wrap with it and the time sits in the bottom-right of the
         expanded bubble — still visually inline with the wrapped nbsps. */}
      {!overCap && (
        <div
          style={{
            position: 'absolute',
            bottom: 6,
            right: 12,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            color: 'var(--fg-3)',
            fontFamily: 'var(--font-sans)',
            fontSize: 11,
            fontStyle: 'normal',
            lineHeight: 1,
            pointerEvents: 'none',
          }}
        >
          {note.updated_at > note.created_at && (
            <span
              role="img"
              aria-label="edited"
              title={`edited ${new Date(note.updated_at).toLocaleString()}`}
              style={{ display: 'inline-flex' }}
            >
              <Pen size={10} />
            </span>
          )}
          <span title={new Date(note.created_at).toLocaleString()}>
            {formatTimestamp(note.created_at)}
          </span>
        </div>
      )}

      {hover && (
        // biome-ignore lint/a11y/noStaticElementInteractions: container only captures clicks to stop propagation to the parent bubble; semantic targets are the inner <button>s.
        // biome-ignore lint/a11y/useKeyWithClickEvents: buttons inside handle keyboard activation; the wrapper has no own keyboard semantics.
        <div
          onClick={(e) => e.stopPropagation()}
          style={{
            position: 'absolute',
            top: -10,
            right: 10,
            display: 'flex',
            gap: 2,
            background: '#fff',
            border: '1px solid var(--border-0)',
            borderRadius: 4,
            padding: 2,
            boxShadow: 'var(--shadow-1)',
          }}
        >
          <button
            type="button"
            title="edit"
            aria-label="edit"
            onClick={onEdit}
            style={{ border: 0, background: 'transparent', cursor: 'pointer', padding: 4 }}
          >
            <Pen size={14} />
          </button>
          <button
            type="button"
            title="copy link"
            aria-label="copy link"
            onClick={onCopyLink}
            style={{ border: 0, background: 'transparent', cursor: 'pointer', padding: 4 }}
          >
            <Link2 size={14} />
          </button>
          <button
            type="button"
            title="delete"
            aria-label={deleteArmed ? 'confirm delete' : 'delete'}
            onClick={handleTrashClick}
            style={{
              border: 0,
              background: deleteArmed ? '#FDECEC' : 'transparent',
              cursor: 'pointer',
              padding: 4,
              color: deleteArmed ? '#E5484D' : 'inherit',
            }}
          >
            <Trash2 size={14} />
          </button>
        </div>
      )}

      {contextMenu && (
        <BubbleContextMenu
          pos={contextMenu}
          onEdit={onEdit}
          onCopyLink={onCopyLink}
          onDelete={onDelete}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  )
}
