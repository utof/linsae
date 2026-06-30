import { ChevronDown, LayoutGrid, Link2, MessagesSquare, Pen, Trash2 } from 'lucide-react'
import { type MouseEvent, useEffect, useRef, useState } from 'react'
import type { Note } from '../../../shared/types'
import { useClock24 } from '../lib/clock-pref'
import { Markdown } from '../lib/markdown'
import { formatTimeOnly } from '../lib/wallclock'
import { type ContextMenuPos, NoteContextMenu } from './ContextMenu'
import { MediaFeedNoteContainer } from './MediaFeedNote'
import { PdfFeedNoteContainer } from './PdfFeedNote'

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
  /** Whether this bubble's over-cap body is expanded. Source of truth lives in
   * Feed so the expand/collapse height morph can be driven by the virtualizer.
   * See adrs/0007-animate-virtual-item-resize.md. */
  expanded: boolean
  /** Toggle request — Feed runs the animated morph + scroll anchoring. */
  onToggleExpand: (id: string) => void
  // Action callbacks take the note id rather than being pre-bound to a
  // closure by the parent. Why: `Feed` renders bubbles inside a `.map()`, and
  // a per-item `() => onFocus(note.id)` closure is recreated every render —
  // which the React Compiler cannot stabilize across renders (no per-loop-
  // iteration memo slot), so the compiler's auto-memo of NoteBubble would
  // bust on every scroll frame. Passing the stable id-callback straight down
  // and binding to `note.id` here (a single component-body value the compiler
  // *can* memoize) lets NoteBubble skip reconcile while it stays in the
  // virtual window. See adrs/0006-react-compiler.md.
  onFocus: (id: string) => void
  onWikilinkClick: (slug: string) => void
  resolveSlug?: (slug: string) => boolean
  onEdit: (id: string) => void
  onDelete: (id: string) => void
  onCopyLink: (id: string) => void
  /** Called when the user clicks "open video notes" on a source-kind note. */
  onOpenThread?: (id: string) => void
  /** True while the Feed's multi-select mode is active. Hides the hover
   * action bar and disables the context menu — row clicks toggle selection
   * (Feed intercepts them in capture phase), so per-note affordances would
   * be dead controls. */
  selecting?: boolean
  /**
   * True when this note has a placed card on the canvas (§9). Drives the ▦
   * trace: placed → an inline ▦ jump chip + the "on canvas" menu verb; unplaced
   * → the "▦+" hover affordance + the "→ shelf" / "place on canvas…" menu verbs.
   * Defaults false so feed callers that don't track placement render unchanged.
   */
  placed?: boolean
  /** Add this note to the shelf, stay in the feed (§4). Bound to note.id here. */
  onShelf?: (id: string) => void
  /** One-shot placement that switches to the canvas (§6). Bound to note.id here. */
  onPlaceOnCanvas?: (id: string) => void
  /** Jump to the existing card on the canvas (§9). Bound to note.id here. */
  onJumpToCard?: (id: string) => void
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
  expanded,
  onToggleExpand,
  onFocus,
  onWikilinkClick,
  resolveSlug,
  onEdit,
  onDelete,
  onCopyLink,
  onOpenThread,
  selecting = false,
  placed = false,
  onShelf,
  onPlaceOnCanvas,
  onJumpToCard,
}: Props) {
  const [hover, setHover] = useState(false)
  const [deleteArmed, setDeleteArmed] = useState(false)
  const [contextMenu, setContextMenu] = useState<ContextMenuPos | null>(null)
  // window.setTimeout returns number in renderer (DOM lib); Node's setTimeout
  // returns NodeJS.Timeout. Tests run in jsdom — the number variant is correct.
  const armTimer = useRef<number | null>(null)
  // 12h/24h wall-clock pref — re-renders this bubble when toggled in Settings.
  const clock24 = useClock24()

  // Bind the id-taking action callbacks to this bubble's id. These are single
  // component-body closures (not per-`.map()`-iteration), so the React
  // Compiler memoizes them — stable identity across re-renders.
  const handleFocus = () => onFocus(note.id)
  const handleEdit = () => onEdit(note.id)
  const handleDelete = () => onDelete(note.id)
  const handleCopyLink = () => onCopyLink(note.id)
  // Optional thread-open — bound in the component body for React Compiler
  // memoization stability (same rationale as the canvas-trace callbacks below).
  const handleOpenThread = onOpenThread ? () => onOpenThread(note.id) : undefined
  // Canvas-trace callbacks, bound to this bubble's id in the body (NOT a
  // per-`.map()` closure) so the React Compiler keeps NoteBubble's props stable
  // across feed scroll. `undefined` when the parent didn't supply the verb.
  const handleShelf = onShelf ? () => onShelf(note.id) : undefined
  const handlePlaceOnCanvas = onPlaceOnCanvas ? () => onPlaceOnCanvas(note.id) : undefined
  const handleJumpToCard = onJumpToCard ? () => onJumpToCard(note.id) : undefined

  const handleContextMenu = (e: MouseEvent) => {
    e.preventDefault()
    if (selecting) return
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
  // needed there.
  //
  // Reservation budget (must exceed time element width or text overlaps):
  //   time text "12:42 AM" ≈ 50px @ 11px Inter
  //   edited pen + gap     ≈ 14px
  //   right padding offset = 12px
  //   total worst-case     ≈ 76px
  // Inter nbsp width @ 14px ≈ 4-5px → 18 nbsps ≈ 72-90px. Comfortable cover
  // for claim bubbles (14px) and question bubbles (16px italic).
  const TIME_RESERVATION = '\u00A0'.repeat(18)
  const displayBody = overCap ? rawDisplayBody : `${rawDisplayBody}${TIME_RESERVATION}`

  const handleTrashClick = (e: MouseEvent) => {
    e.stopPropagation()
    if (deleteArmed) {
      if (armTimer.current !== null) clearTimeout(armTimer.current)
      setDeleteArmed(false)
      onDelete(note.id)
      return
    }
    setDeleteArmed(true)
    armTimer.current = window.setTimeout(() => setDeleteArmed(false), 2000)
  }

  // Clear the arm timer on unmount so a pending setTimeout doesn't fire
  // setState on a virtualised-out bubble (Feed uses @tanstack/react-virtual).
  useEffect(
    () => () => {
      if (armTimer.current !== null) clearTimeout(armTimer.current)
    },
    [],
  )

  // ▦ "on canvas" jump chip — rendered inline in the time row when the note is
  // placed (§9 D2). Clickable (pointerEvents auto even inside the time row's
  // pointerEvents:none wrapper); stopPropagation so it doesn't also focus the
  // bubble. `null` when unplaced — the hover "▦+" affordance covers that case.
  const placedChip =
    placed && handleJumpToCard ? (
      <button
        type="button"
        title="on canvas — jump to card"
        aria-label="on canvas"
        onClick={(e) => {
          e.stopPropagation()
          handleJumpToCard()
        }}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          border: 0,
          background: 'transparent',
          color: 'var(--type-source)',
          cursor: 'pointer',
          padding: 0,
          pointerEvents: 'auto',
          fontSize: 11,
          lineHeight: 1,
        }}
      >
        <LayoutGrid size={11} />
      </button>
    ) : null

  // PDF document-level branch: render PdfFeedNoteContainer for a doc-level PDF
  // source note (no page anchor). The `page == null` check (covers both null and
  // undefined) is the load-bearing discriminator: excerpts are ALSO
  // source_kind:'pdf' but carry a page field, so a source_kind-only check would
  // mis-render every excerpt as a document card. The `type === 'source'` guard
  // mirrors the youtube `isSource` branch and pre-empts a page-less PDF comment-
  // note (a future type:'claim' shape) ever colliding with the doc-card path.
  // Why checked after all hooks: Rules of Hooks require no conditional hook calls.
  const isPdfDoc =
    note.type === 'source' &&
    note.source_kind === 'pdf' &&
    note.source_locator?.media === 'pdf' &&
    note.source_locator.page == null
  if (isPdfDoc) {
    return (
      <PdfFeedNoteContainer
        note={note}
        {...(onOpenThread ? { onOpenThread } : {})}
        onDelete={handleDelete}
        onCopyLink={handleCopyLink}
      />
    )
  }

  // Source-kind branch: render the MediaFeedNoteContainer card instead of a
  // standard text bubble. Checked here (after all hooks) so the Rules of Hooks
  // are satisfied. Requires type === 'source' to exclude comment-notes (type:
  // 'claim'/'question') that also carry source_kind:'youtube' + source_locator.t
  // — those must render as normal bubbles showing their markdown body/screenshot.
  // Why: comment-notes created by ⌘⇧C have { type:'claim', source_kind:'youtube',
  // source_locator:{ media:'youtube', video_id, t } }; without the type guard
  // they incorrectly render as video cards in the main feed.
  const isSource =
    note.type === 'source' &&
    note.source_kind === 'youtube' &&
    note.source_locator?.media === 'youtube'
  if (isSource) {
    return (
      <MediaFeedNoteContainer
        note={note}
        {...(onOpenThread ? { onOpenThread } : {})}
        onDelete={handleDelete}
        onCopyLink={handleCopyLink}
      />
    )
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: bubble is a click target for focus selection; keyboard nav lives on Composer / palette per spec.
    // biome-ignore lint/a11y/useKeyWithClickEvents: focus selection is mouse-only at v0.1 (see spec §Keyboard — no E shortcut for bubble selection).
    <div
      data-bubble
      onClick={handleFocus}
      onContextMenu={handleContextMenu}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        position: 'relative',
        background: bg,
        border: `1px solid ${border}`,
        // Focused rail is drawn as an inset box-shadow on the left edge
        // instead of overriding border-left to 2px. Border-width change
        // would shift the content right by 1px when a bubble gets focused
        // — visible jiggle on click. Box-shadow does not affect layout,
        // so width / padding / content position stay pixel-stable across
        // the focus state transition.
        boxShadow: focused ? 'inset 2px 0 0 #0D99FF' : 'none',
        borderRadius: 14,
        padding: '6px 12px',
        // Inter-bubble vertical gap lives on the Feed item wrapper as
        // padding — NOT margin here — so tanstack-virtual's `measureElement`
        // (read from getBoundingClientRect → border-box) includes the gap.
        // Margin would sit outside content-box and under-report measured
        // size by 6px per bubble, throwing off the virtualizer's totalSize.
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
      {/* data-bubble-body: Feed's expand/collapse morph sets this element's
         height (overflow:hidden) frame-by-frame to roll the body up/down.
         See useExpandCollapseMorph. */}
      <div data-bubble-body style={{ position: 'relative' }}>
        <Markdown
          body={displayBody}
          onWikilinkClick={onWikilinkClick}
          {...(resolveSlug ? { resolveSlug } : {})}
        />
        {overCap && !expanded && (
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
        )}
      </div>

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
              onToggleExpand(note.id)
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
            {placedChip}
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
              {formatTimeOnly(note.created_at, !clock24)}
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
          {placedChip}
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
            {formatTimeOnly(note.created_at, !clock24)}
          </span>
        </div>
      )}

      {hover && !selecting && (
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
          {/* Every icon button MUST set an explicit `color` (the lucide glyph paints
             with `stroke: currentColor`). Without it a <button> falls back to the
             UA-default text color, which is color-scheme-dependent: under a dark OS
             theme — and the app never pins `color-scheme: light` — that default is
             WHITE, so the glyph vanishes on this white pill. Only `delete` survived
             (it alone set `color: inherit` → --fg-0), which is why the bar collapsed
             to a lone trash icon for dark-theme users (B11). The systemic root cause
             is that the app never declares `color-scheme: light` on :root. */}
          {/* "▦+" add-to-shelf affordance (§4) — only when unplaced; once placed
             the inline ▦ jump chip in the time row replaces it. */}
          {!placed && handleShelf && (
            <button
              type="button"
              title="add to shelf"
              aria-label="add to shelf"
              onClick={handleShelf}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                border: 0,
                background: 'transparent',
                cursor: 'pointer',
                padding: 4,
                position: 'relative',
                color: 'var(--fg-0)',
              }}
            >
              <LayoutGrid size={14} />
              <span
                aria-hidden="true"
                style={{ fontSize: 9, fontWeight: 700, marginLeft: 1, lineHeight: 1 }}
              >
                +
              </span>
            </button>
          )}
          {handleOpenThread && (
            <button
              type="button"
              title="open thread"
              aria-label="open thread"
              onClick={handleOpenThread}
              style={{
                border: 0,
                background: 'transparent',
                cursor: 'pointer',
                padding: 4,
                color: 'var(--fg-0)',
              }}
            >
              <MessagesSquare size={14} />
            </button>
          )}
          <button
            type="button"
            title="edit"
            aria-label="edit"
            onClick={handleEdit}
            style={{
              border: 0,
              background: 'transparent',
              cursor: 'pointer',
              padding: 4,
              color: 'var(--fg-0)',
            }}
          >
            <Pen size={14} />
          </button>
          <button
            type="button"
            title="copy link"
            aria-label="copy link"
            onClick={handleCopyLink}
            style={{
              border: 0,
              background: 'transparent',
              cursor: 'pointer',
              padding: 4,
              color: 'var(--fg-0)',
            }}
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
              // --fg-0 (not `inherit`) so it matches the other icon buttons and never
              // resolves to the color-scheme-dependent UA default (B11).
              color: deleteArmed ? '#E5484D' : 'var(--fg-0)',
            }}
          >
            <Trash2 size={14} />
          </button>
        </div>
      )}

      {/* Why `!selecting`: if selection mode starts via keyboard (x/Shift+Arrow)
         while a context menu is open, no mousedown-outside fires to close it —
         so we gate it here to ensure a linger-open menu is unmounted the
         moment the bubble enters selecting mode. */}
      {contextMenu && !selecting && (
        <NoteContextMenu
          pos={contextMenu}
          onEdit={handleEdit}
          onCopyLink={handleCopyLink}
          onDelete={handleDelete}
          onClose={() => setContextMenu(null)}
          // Placed → a single "on canvas" jump verb; unplaced → "→ shelf" +
          // "place on canvas…" (§4/§9). undefined verbs are simply omitted by
          // NoteContextMenu, so feed callers that don't track placement keep the
          // original edit/copy/delete menu.
          {...(placed
            ? handleJumpToCard
              ? { onJumpToCard: handleJumpToCard }
              : {}
            : {
                ...(handleShelf ? { onShelf: handleShelf } : {}),
                ...(handlePlaceOnCanvas ? { onPlaceOnCanvas: handlePlaceOnCanvas } : {}),
              })}
        />
      )}
    </div>
  )
}
