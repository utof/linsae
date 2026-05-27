import { ChevronDown, Link2, Pen, Trash2 } from 'lucide-react'
import { type MouseEvent, useEffect, useRef, useState } from 'react'
import type { Note } from '../../../shared/types'
import { Markdown } from '../lib/markdown'

/**
 * Hard cap on the rendered body length before the fade-out + expand
 * affordance kicks in. 4096 is a "data-structure nice" power-of-two
 * round number chosen by the user — large enough that essentially no
 * normal note bumps into it, small enough that one bubble rendering a
 * pasted 10k-char log doesn't dominate the feed's visual rhythm.
 */
const BODY_TRUNCATE_AT = 4096

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
  // window.setTimeout returns number in renderer (DOM lib); Node's setTimeout
  // returns NodeJS.Timeout. Tests run in jsdom — the number variant is correct.
  const armTimer = useRef<number | null>(null)

  const isQuestion = note.type === 'question'
  const bg = focused ? 'var(--bg-3)' : isQuestion ? '#FFFBF0' : '#FFFFFF'
  const border = isQuestion ? '#FAEAC2' : 'var(--border-0)'

  // Truncate display body at BODY_TRUNCATE_AT chars and surface an expand
  // affordance when the user hasn't expanded yet. Word count uses the FULL
  // body so the affordance shows the cost of expansion ("expand (3.2k
  // words)"). split(/\s+/) on a trimmed string is fine for word-counting
  // English-ish prose at v0.1; CJK and other scripts will under-count
  // (tracked as nit, not blocking).
  const overCap = note.body.length > BODY_TRUNCATE_AT
  const displayBody = overCap && !expanded ? note.body.slice(0, BODY_TRUNCATE_AT) : note.body
  const wordCount = overCap ? note.body.trim().split(/\s+/).length : 0

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
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        position: 'relative',
        background: bg,
        border: `1px solid ${border}`,
        borderLeft: focused ? '2px solid #0D99FF' : `1px solid ${border}`,
        borderRadius: 14,
        padding: '10px 14px',
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

      {overCap && (
        <button
          type="button"
          aria-label={expanded ? 'collapse note' : `expand note — ${wordCount} words`}
          onClick={(e) => {
            e.stopPropagation()
            setExpanded((v) => !v)
          }}
          style={{
            marginTop: 8,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            border: 0,
            background: 'transparent',
            color: 'var(--fg-2)',
            fontFamily: 'var(--font-sans)',
            fontSize: 12,
            fontStyle: 'normal',
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
    </div>
  )
}
