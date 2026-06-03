import type { Ref } from 'react'
import { createPortal } from 'react-dom'
import type { NoteType } from '../../../shared/types'
import { Markdown } from '../lib/markdown'

interface Props {
  body: string
  mode: NoteType
  top: number
  left: number
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
 * @see src/renderer/src/feed/ContextMenu.tsx §portal-to-body / transformed-ancestor escape
 */
export function SendGhost({ body, mode, top, left, ref }: Props) {
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
        willChange: 'transform, opacity',
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
          The ghost is a visual clone; clicks are blocked by pointerEvents:none. */}
      <Markdown body={body} onWikilinkClick={() => {}} />
    </div>,
    document.body,
  )
}
