import { useEffect, useRef, useState } from 'react'
import { SendButton } from '../composer/SendButton'
import { useAutoGrowTextarea } from '../composer/useAutoGrowTextarea'

/**
 * Minimal thread composer for plain/PDF threads: an auto-grow textarea plus a
 * send button. Enter posts a comment-on child (ADR 0001), Shift+Enter inserts a
 * newline; the send button submits the same draft. A trim-empty guard prevents
 * blank posts. No media chrome — this is the minimal case; the only chrome
 * beyond textarea + send is the parent-owned error line (see `error`).
 *
 * **Clear-on-success contract (ADR 0063).** This composer NEVER clears its own
 * draft optimistically: `submit()` awaits `onSubmit` and clears the textarea
 * (and signals `onDraftClear`) only when it resolves.
 *
 * Why the shared pieces: this composer adopts the same `useAutoGrowTextarea`
 * hook and `SendButton` as the feed `Composer` and the YouTube `ThreadComposer`
 * (the unified base). Each context still owns its own chrome — this one is the
 * bare text-in case, so it stops at textarea + send + the error line.
 *
 * Styling mirrors `src/renderer/src/thread/ThreadComposer.tsx`: same v21 tokens
 * (--font-sans, --fg-0, --border-1, --r-4, --shadow-2), same 13px / 1.5 text,
 * same bottom-right send arrow. No hardcoded colors.
 *
 * @issue utof/linsae#161
 * @see adrs/0063-composer-clears-on-success.md (the contract, and why)
 * @see docs/specs/v0.6.4-notes-as-threads.md
 * @see adrs/0001-enter-key-sends.md
 * @see src/renderer/src/composer/useAutoGrowTextarea.ts (shared auto-grow)
 * @see src/renderer/src/composer/SendButton.tsx (shared send affordance)
 */
export function SimpleComposer({
  onSubmit,
  error = null,
  onClearError,
  initialDraft = '',
  onDraftChange,
  onDraftClear,
}: {
  /**
   * Posts the trimmed body. May be async: `submit()` awaits it and treats a
   * REJECTION as "nothing was posted" — the draft is left exactly as typed.
   * A resolving `onSubmit` therefore means "the note exists"; a parent that
   * swallows its own failure re-introduces #161 one layer up.
   * @see adrs/0063-composer-clears-on-success.md
   */
  onSubmit: (body: string) => void | Promise<void>
  /**
   * User-facing error from the last post attempt (e.g. duplicate-slug). When
   * set, the card border turns red and the message renders below; the draft is
   * preserved so the user can edit + retry. Mirrors `ThreadComposer`'s UX.
   *
   * PARENT-OWNED, deliberately: `ThreadView` already holds `postError` for the
   * YouTube branch, and a second, composer-local copy is two owners that can
   * disagree — which is how this bug class recurs.
   * @see adrs/0063-composer-clears-on-success.md
   */
  error?: string | null
  /** Called on the next keystroke when `error` is set, so the parent clears it. */
  onClearError?: () => void
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
   * Called once `onSubmit` has RESOLVED, so App drops this root's entry from
   * the draft map. Never fires on a trimmed-empty no-op, on a rejected post, or
   * when the textarea still holds live text the user typed mid-flight — the
   * persisted entry and the on-screen draft are cleared together or not at all.
   * @see adrs/0063-composer-clears-on-success.md
   */
  onDraftClear?: (() => void) | undefined
}) {
  const [body, setBody] = useState(initialDraft)
  const ref = useAutoGrowTextarea(body)

  // `body` as of the latest keystroke. `submit()` awaits, so its closed-over
  // `body` is stale by the time the post resolves; this ref is what the
  // clobber check reads. Written only where `setBody` is (onChange + the
  // success clear), never during render.
  const bodyRef = useRef(initialDraft)
  // Double-submit guard (Enter held, double-click). A ref, not state: it must
  // flip on the SAME stack as the first keydown, before any await. A second
  // `notes.create` for the same body is itself a duplicate-slug throw.
  const inFlight = useRef(false)

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
  // whitespace-only draft is a no-op. On a RESOLVED post — and only then —
  // clear the draft AND signal App to drop the persisted entry.
  const submit = async () => {
    const trimmed = body.trim()
    if (!trimmed || inFlight.current) return
    inFlight.current = true
    try {
      await onSubmit(trimmed)
    } catch {
      // A failed post clears NOTHING. The error surface is the parent's `error`
      // prop, fed by ThreadView's `postError`; catching here only stops the
      // rejection from going unhandled. The `catch` is deliberately narrow — it
      // wraps ONLY `onSubmit`, so a throw from `onDraftClear?.()` below is not
      // silently swallowed too. Same shape as `ThreadComposer.submit`.
      return
    } finally {
      inFlight.current = false
    }
    // Clobber guard: the post took a real IPC round-trip, so the user may have
    // typed since. Clear only if the textarea still trims to what was sent —
    // otherwise both the visible draft and the persisted entry keep the newer
    // text, and they stay in agreement.
    if (bodyRef.current.trim() !== trimmed) return
    bodyRef.current = ''
    setBody('')
    onDraftClear?.()
  }

  return (
    <div
      style={{
        background: '#fff',
        border: `1px solid ${error ? 'var(--status-wtf)' : 'var(--border-1)'}`,
        borderRadius: 'var(--r-4)',
        boxShadow: 'var(--shadow-2)',
        padding: '7px 9px',
      }}
    >
      <textarea
        ref={ref}
        rows={1}
        value={body}
        onChange={(e) => {
          if (error) onClearError?.()
          bodyRef.current = e.target.value
          setBody(e.target.value)
        }}
        onKeyDown={(e) => {
          // Enter sends (ADR 0001); Shift+Enter inserts a newline (browser default).
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            void submit()
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
        <SendButton
          onClick={() => {
            void submit()
          }}
          label="add note"
          title="add note ↵"
        />
      </div>

      {/* Parent-owned failure line, mirroring ThreadComposer's error block.
          Without it, fixing the clear only converts silent data-loss into silent
          nothing-happening. @see adrs/0063-composer-clears-on-success.md */}
      {error && (
        <div
          role="alert"
          style={{
            marginTop: 6,
            color: 'var(--status-wtf)',
            fontSize: 12,
            lineHeight: 1.4,
          }}
        >
          {error}
        </div>
      )}
    </div>
  )
}
