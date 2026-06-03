import type { Ref } from 'react'
import { createPortal } from 'react-dom'
import type { NoteType } from '../../../shared/types'
import { Markdown } from '../lib/markdown'
import { formatTimeOnly } from '../lib/wallclock'

/**
 * Trailing non-breaking-space run that reserves room on the last text line for
 * the absolutely-positioned time — kept BYTE-FOR-BYTE in sync with
 * NoteBubble.tsx's `TIME_RESERVATION` (18 nbsps) so the ghost's bubble wraps to
 * the exact same width as the real feed note. If NoteBubble's reservation
 * changes, change this too. See NoteBubble.tsx §"Telegram-style time floats".
 */
const TIME_RESERVATION = '\u00A0'.repeat(18)

interface Props {
  body: string
  mode: NoteType
  top: number
  left: number
  /**
   * Wall-clock instant shown bottom-right, matching the real note's `created_at`.
   * Captured at launch (≈ now); the ghost flies < 0.5s so it's the same HH:MM.
   */
  createdAt: number
  /** 12h vs 24h display — the live `useClock24` pref, passed as `!clock24`. */
  hour12: boolean
  ref?: Ref<HTMLDivElement>
}

/**
 * Presentational ghost bubble for the iMessage-style send animation.
 *
 * Why: this is a dumb, position:fixed clone of a feed NoteBubble, portaled to
 * document.body so it escapes any transformed ancestor (the same escape hatch
 * ContextMenu.tsx uses — see its §Portaling comment). A separate hook
 * (useSendAnimation, Task 3) mounts/unmounts it and drives its
 * transform/opacity per rAF via the forwarded ref. This component deliberately
 * contains zero animation logic — it is purely presentational so the hook can
 * be tested/swapped independently.
 *
 * Pixel-sameness with the landing note: the ghost mirrors NoteBubble's
 * non-overCap path — same box, same body PLUS the `TIME_RESERVATION` nbsps, and
 * the same bottom-right time element — so on hand-off the ghost and the real
 * note are visually identical (no width snap, no missing timestamp). The rare
 * over-cap case (a >4096-char send) is not pixel-matched; the eye is over the
 * clearing composer at liftoff and such sends are vanishingly rare.
 *
 * Ref-as-prop (not forwardRef): this codebase targets React 19 (react@^19.2.1)
 * where refs are plain props. No existing component in src/renderer uses
 * forwardRef, so this matches the prevailing pattern.
 *
 * Note on portal safety: the app shell (html/body/#root/WindowFrame/<main>)
 * currently carries no transform/filter/will-change/perspective/contain, so
 * fixed coords are viewport-relative. Should a future refactor add a transform
 * on #root, the ghost would break — the portal-to-body here is the guard.
 *
 * @see docs/specs/v0.2.1-send-animation.md
 * @see src/renderer/src/feed/NoteBubble.tsx §"Telegram-style time floats" / non-overCap render
 * @see src/renderer/src/feed/ContextMenu.tsx §portal-to-body / transformed-ancestor escape
 */
export function SendGhost({ body, mode, top, left, createdAt, hour12, ref }: Props) {
  const isQuestion = mode === 'question'

  // Styling mirrors NoteBubble.tsx lines ~115–235 for the bubble box and body text.
  // No boxShadow (ghost is a transient flourish, not a resting card).
  return createPortal(
    <div
      ref={ref}
      data-testid="send-ghost"
      style={{
        position: 'fixed',
        top,
        left,
        maxWidth: 560,
        pointerEvents: 'none',
        // Only transform animates now (Motion spring); the ghost no longer fades —
        // it hands off to the real note on landing (useSendAnimation).
        willChange: 'transform',
        // z-index 1000 matches NoteContextMenu (ContextMenu.tsx:113) — the
        // overlay layer above feed items and the composer, but on the same
        // tier as the context menu so they don't clash.
        zIndex: 1000,
        // NoteBubble box styling (NoteBubble.tsx:216/217/223)
        borderRadius: 14,
        padding: '6px 12px',
        background: isQuestion ? '#FFFBF0' : '#FFFFFF',
        border: isQuestion ? '1px solid #FAEAC2' : '1px solid var(--border-1)',
        // NoteBubble body text styling (NoteBubble.tsx:224–234)
        fontFamily: isQuestion ? 'var(--font-serif)' : 'var(--font-sans)',
        fontStyle: isQuestion ? 'italic' : 'normal',
        fontSize: isQuestion ? 16 : 14,
        color: 'var(--fg-0)',
        overflowWrap: 'anywhere',
      }}
    >
      {/* Non-interactive: no onWikilinkClick, resolveSlug, or onYtSeek wired.
          The ghost is a visual clone; clicks are blocked by pointerEvents:none.
          The TIME_RESERVATION nbsps reserve the same last-line width the real
          bubble does, so the ghost wraps identically (NoteBubble.tsx:150). */}
      <Markdown body={`${body}${TIME_RESERVATION}`} onWikilinkClick={() => {}} />
      {/* Bottom-right time, mirroring NoteBubble's non-overCap footer
          (NoteBubble.tsx:333–363). A freshly-sent note is never edited, so no
          pen icon. Absolute within this fixed box → same bottom:6/right:12 slot. */}
      <span
        style={{
          position: 'absolute',
          bottom: 6,
          right: 12,
          display: 'inline-flex',
          alignItems: 'center',
          color: 'var(--fg-3)',
          fontFamily: 'var(--font-sans)',
          fontSize: 11,
          fontStyle: 'normal',
          lineHeight: 1,
          pointerEvents: 'none',
        }}
      >
        {formatTimeOnly(createdAt, hour12)}
      </span>
    </div>,
    document.body,
  )
}
