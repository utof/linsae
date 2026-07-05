import { useEffect, useRef, useState } from 'react'
import { SendButton } from '../composer/SendButton'
import { useAutoGrowTextarea } from '../composer/useAutoGrowTextarea'

/**
 * Minimal thread composer for plain/PDF threads: an auto-grow textarea plus a
 * send button. Enter posts a comment-on child (ADR 0001), Shift+Enter inserts a
 * newline; the send button submits the same draft. A trim-empty guard prevents
 * blank posts. No media chrome, no error surface — this is the minimal case.
 *
 * Why the shared pieces: this composer adopts the same `useAutoGrowTextarea`
 * hook and `SendButton` as the feed `Composer` and the YouTube `ThreadComposer`
 * (the unified base). Each context still owns its own chrome — this one is the
 * bare text-in case, so it stops at textarea + send.
 *
 * Styling mirrors `src/renderer/src/thread/ThreadComposer.tsx`: same v21 tokens
 * (--font-sans, --fg-0, --border-1, --r-4, --shadow-2), same 13px / 1.5 text,
 * same bottom-right send arrow. No hardcoded colors.
 *
 * @see docs/specs/v0.6.4-notes-as-threads.md
 * @see adrs/0001-enter-key-sends.md
 * @see src/renderer/src/composer/useAutoGrowTextarea.ts (shared auto-grow)
 * @see src/renderer/src/composer/SendButton.tsx (shared send affordance)
 */
export function SimpleComposer({
  onSubmit,
  initialDraft = '',
  onDraftChange,
  onDraftClear,
}: {
  onSubmit: (body: string) => void
  /**
   * Restored draft text for THIS thread's root, applied ONCE as the initial
   * `body` (v0.7 Task 4.2). App sources it from `snap.data.draftThread[rootId]`.
   * @see docs/plans/v0.7-session-persistence.md §Task 4.2
   */
  // `| undefined` (not just `?`) so ThreadView can forward a possibly-absent
  // `draftThreadMap[id]` lookup directly under `exactOptionalPropertyTypes`.
  initialDraft?: string | undefined
  /**
   * Reports the live draft text up whenever it changes — App keys it by the
   * thread root id and write-throughs it to `composer.draft.thread.v1`
   * (debounced). NOT called on the initial mount (skip-first): the seeded value
   * must not echo back to disk. Text only — App closes over the root id.
   * @see src/renderer/src/App.tsx §draftThreadMap
   */
  onDraftChange?: ((text: string) => void) | undefined
  /**
   * Called on a real send (optimistic, in the submit path where local state is
   * cleared) so App drops this root's entry from the draft map. Fires only on a
   * non-empty post — a trimmed-empty no-op does not clear.
   */
  onDraftClear?: (() => void) | undefined
}) {
  const [body, setBody] = useState(initialDraft)
  const ref = useAutoGrowTextarea(body)

  // Report the live draft up (v0.7 persistence). Skip-first is expressed as
  // "differs from the seed" rather than a boolean flag so it survives StrictMode's
  // dev double-invoke of mount effects (both invokes see body === the seed → no
  // report). The compare-to-last-reported guard also makes an unstable
  // `onDraftChange` harmless. Mirrors Composer.tsx's reporter.
  // @see src/renderer/src/composer/Composer.tsx §onDraftChange
  const lastReported = useRef(initialDraft)
  useEffect(() => {
    if (lastReported.current === body) return
    lastReported.current = body
    onDraftChange?.(body)
  }, [body, onDraftChange])

  // Submit path shared by Enter and the send button. Trim-empty guard: a
  // whitespace-only draft is a no-op. On a real post, clear the draft AND
  // signal App to drop the persisted entry (clear-and-cancel on send).
  const submit = () => {
    const t = body.trim()
    if (t) {
      onSubmit(t)
      setBody('')
      onDraftClear?.()
    }
  }

  return (
    <div
      style={{
        background: '#fff',
        border: '1px solid var(--border-1)',
        borderRadius: 'var(--r-4)',
        boxShadow: 'var(--shadow-2)',
        padding: '7px 9px',
      }}
    >
      <textarea
        ref={ref}
        rows={1}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          // Enter sends (ADR 0001); Shift+Enter inserts a newline (browser default).
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            submit()
          }
        }}
        placeholder="add a note…"
        style={{
          width: '100%',
          boxSizing: 'border-box',
          border: 0,
          outline: 'none',
          resize: 'none',
          overflowY: 'auto',
          fontFamily: 'var(--font-sans)',
          fontSize: 13,
          lineHeight: 1.5,
          color: 'var(--fg-0)',
          background: 'transparent',
          padding: 0,
        }}
      />
      {/* Bottom row: bare send arrow on the right (no label — the arrow is the
          affordance), matching ThreadComposer's Telegram-style toolbar. */}
      <div style={{ display: 'flex', alignItems: 'center', marginTop: 6 }}>
        <div style={{ flex: 1 }} />
        <SendButton onClick={submit} label="add note" title="add note ↵" />
      </div>
    </div>
  )
}
