import {
  type ClipboardEvent,
  type KeyboardEvent,
  type Ref,
  useEffect,
  useRef,
  useState,
} from 'react'
import type { NoteType } from '../../../shared/types'
import { FEED_BAND, type FeedBand } from '../feed/feedBand'
import { SendButton } from './SendButton'
import { useAutoGrowTextarea } from './useAutoGrowTextarea'

interface Props {
  onSubmit: (input: { body: string; type: NoteType }) => void
  onCancel: () => void
  initialBody: string
  initialMode: NoteType
  editMode?: boolean
  /**
   * User-facing error from the last submit attempt (e.g. duplicate-slug).
   * When non-null, the textarea border turns red (`--status-wtf`) and the
   * message renders below the textarea. The body text + cursor are NOT
   * mutated — the user can edit and retry. Cleared by the next keystroke
   * via `onClearError`.
   */
  error?: string | null
  /**
   * Called on the next keystroke when `error` is set. Lets the parent
   * (App.tsx) drop its `submitError` state so the next render passes
   * `error={null}` and the red UI disappears.
   */
  onClearError?: () => void
  /**
   * Optional paste interceptor for the create-mode composer (never called in
   * edit mode). Receives the pasted plain-text string; return `true` to
   * signal the paste was fully handled (prevents default textarea insertion),
   * `false` / `undefined` to let the default paste proceed.
   *
   * Why a callback instead of handling in App directly: the textarea's
   * ClipboardEvent fires on the textarea DOM node, so the seam is most
   * natural here. Keeping the interceptor optional preserves the edit-mode
   * Composer's existing contract unchanged (no regressions).
   *
   * @see src/renderer/src/App.tsx §paste handler
   */
  onPasteText?: (text: string) => boolean
  /**
   * Optional draft reporter (v0.7 session persistence). Called with the live
   * `{ body, mode }` whenever either changes — App keeps this as `draftFeed` state
   * and write-throughs it to `composer.draft.feed.v1` (debounced). NOT called on the
   * initial mount (skip-first): the mount value is either a boot-restored draft (must
   * not echo back to disk) or the fresh empty composer after a send (must not resurrect
   * the just-cleared draft — App writes `null` on successful send). Only the create-mode
   * composer wires this; edit-mode never persists a draft.
   * @see src/renderer/src/App.tsx §draftFeed
   * @see docs/specs/v0.7-session-persistence.md §Composer draft
   */
  onDraftChange?: (draft: { body: string; mode: NoteType }) => void
  /**
   * Optional ref to the composer card-root element. Currently unused at the call
   * site (the send ghost that needed it was removed — ADR 0020); kept as the natural
   * anchor for the planned composer→note morph (the endgame send animation).
   */
  cardRef?: Ref<HTMLDivElement>
  /**
   * "Model A" feed band (ADR 0047). The feed-view composer must move + shrink in
   * lockstep with the feed column — feed and composer are one centered unit. App
   * computes the band once (`computeFeedBand`) and threads the SAME value to both
   * `<Feed>` and this composer so their centered band, max/min width, and
   * shrink-on-dock-encroach are identical. `null`/undefined ⇒ the default centered
   * `FEED_BAND.default` band with auto margins (byte-identical to the pre-dock
   * layout, and the shape the canvas edit-composer keeps). @see src/renderer/src/feed/feedBand.ts
   */
  band?: FeedBand | null
}

/**
 * Sticky-bottom Composer for the Telegram-style feed.
 *
 * Modes:
 *  - `claim` (default): white background, sans, 14px, 1-row textarea.
 *  - `question`: amber accent (`var(--type-question)` = `#F5A623`), italic
 *    Newsreader at 16px, 2-row textarea, "QUESTION — ESC TO CLEAR" pill.
 *
 * Key bindings (see `adrs/0001-enter-key-sends.md` and spec §Keyboard):
 *  - `Enter` submits with `{ body, type: mode }`; `Shift+Enter` inserts a newline.
 *  - `?` on an empty composer in `claim` mode promotes to `question` mode.
 *    Why the empty-composer guard: pressing `?` mid-sentence should be a literal
 *    character, not a mode flip — hijacking it would break sentences like "is
 *    this true?". The v21 prototype uses the same heuristic for `Q`/`C`/`S`.
 *  - `Escape` (spec §Esc precedence):
 *      1. question mode → clear back to claim + stopPropagation.
 *      2. editMode → onCancel() + stopPropagation.
 *      3. plain claim mode → let the global handler resolve (no stopPropagation).
 *    Why stopPropagation in (1) and (2): the renderer's global `keydown`
 *    handler also listens for Esc (palette / backlinks). Without it, a single
 *    Esc could execute two precedence steps in one frame, violating spec
 *    ordering.
 *
 * Why auto-focus on mount: per spec §"What 'done' means" the composer is
 * focused on app open and after every send — the feed is the primary
 * input surface, not the bubble list.
 *
 * @see docs/specs/v0.1-rolling-feed-and-search.md §Composer
 * @see adrs/0001-enter-key-sends.md
 * @see v21-design-system/project/ui_kits/v21-app/composer.jsx
 */
export function Composer({
  onSubmit,
  onCancel,
  initialBody,
  initialMode,
  editMode = false,
  error = null,
  onClearError,
  onPasteText,
  onDraftChange,
  cardRef,
  band = null,
}: Props) {
  const [body, setBody] = useState(initialBody)
  const [mode, setMode] = useState<NoteType>(initialMode)
  // Auto-grow textarea via the shared hook (also used by ThreadComposer +
  // SimpleComposer). Runs on `body` — including the edit-mode prefill — so the
  // textarea sizes to the initial text without a `rows` prop.
  const ref = useAutoGrowTextarea(body)

  useEffect(() => {
    ref.current?.focus()
  }, [ref])

  // Report the live draft up (v0.7 persistence). Skip-first is expressed as
  // "differs from the seed" rather than a boolean flag so it survives StrictMode's
  // dev double-invoke of mount effects (both invokes see body/mode === the seed →
  // no report). The compare-to-last-reported guard also makes an unstable
  // `onDraftChange` harmless: a re-run with unchanged body/mode returns early, so
  // there is no render loop even without a memoised callback.
  const lastReported = useRef({ body: initialBody, mode: initialMode })
  useEffect(() => {
    if (lastReported.current.body === body && lastReported.current.mode === mode) return
    lastReported.current = { body, mode }
    onDraftChange?.({ body, mode })
  }, [body, mode, onDraftChange])

  const submit = () => {
    if (!body.trim()) return
    onSubmit({ body, type: mode })
    // Do NOT clear local body/mode here. The parent owns success-vs-failure
    // (the mutation is async) and remounts this Composer via a key change on
    // success, which gives us a fresh `initialBody=''`. On failure the parent
    // leaves the key alone, so this Composer keeps the user's text + cursor
    // intact — they edit and retry without retyping. See issue #23 (Option B).
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === '?' && body.length === 0 && mode === 'claim' && !e.metaKey && !e.ctrlKey) {
      e.preventDefault()
      setMode('question')
      return
    }
    if (e.key === 'Escape') {
      if (mode === 'question') {
        e.preventDefault()
        e.stopPropagation()
        setMode('claim')
        return
      }
      if (editMode) {
        e.preventDefault()
        e.stopPropagation()
        onCancel()
        return
      }
      // else: fall through — global handler resolves (palette / backlinks / no-op).
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit()
    }
  }

  // Paste interceptor — only active in create mode when onPasteText is provided.
  // Edit-mode composers never carry onPasteText, so this is a no-op for them.
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    if (!onPasteText) return
    const text = e.clipboardData.getData('text')
    const handled = onPasteText(text)
    if (handled) e.preventDefault()
  }

  const isQuestion = mode === 'question'
  // Error border wins over question-mode border so the user sees the failure
  // state even when the composer is in amber question mode.
  const borderColor = error
    ? 'var(--status-wtf)'
    : isQuestion
      ? 'var(--type-question)'
      : 'var(--border-1)'

  return (
    <div
      style={{
        // Surrender the symmetric 32px horizontal padding to the band's gutters
        // when a dock is open (mirrors Feed's outer), so the composer's band sits
        // at the SAME horizontal position as the feed column. Vertical padding is
        // unchanged. No dock ⇒ the original `12px 32px 24px`.
        padding: band ? '12px 0 24px' : '12px 32px 24px',
        background: 'var(--bg-0)',
      }}
    >
      <div
        // No CSS `min-width` (B14): the band shrinks to fit its container so the
        // composer can never overflow under a dock; the dock's render width is
        // window-capped to keep the column ≥ FEED_BAND.min in normal cases. Mirrors
        // Feed. @see adrs/0047-feed-default-width-docks-fill-gutters.md
        style={
          band
            ? {
                maxWidth: band.maxWidth,
                marginLeft: band.marginLeft,
                marginRight: band.marginRight,
              }
            : { maxWidth: FEED_BAND.default, margin: '0 auto' }
        }
      >
        <div
          ref={cardRef}
          style={{
            position: 'relative',
            background: '#fff',
            border: `1px solid ${borderColor}`,
            borderRadius: 10,
            boxShadow: 'var(--shadow-2)',
            padding: '10px 12px 8px',
          }}
        >
          {isQuestion && (
            <div
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                marginBottom: 6,
                padding: '2px 8px',
                borderRadius: 2,
                background: 'var(--type-question)',
                color: '#fff',
                fontSize: 11,
                fontWeight: 600,
                letterSpacing: '0.04em',
                textTransform: 'uppercase',
              }}
            >
              question — esc to clear
            </div>
          )}
          <textarea
            ref={ref}
            value={body}
            onChange={(e) => {
              if (error && onClearError) onClearError()
              setBody(e.target.value)
            }}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            aria-label={isQuestion ? 'ask a question' : 'write a note'}
            placeholder={isQuestion ? 'ask a question…' : 'write — or press ? for a question'}
            // Class hides the native scrollbar (rules in globals.css); native
            // caret-driven scroll still works for past-cap content.
            className="composer-textarea"
            style={{
              width: '100%',
              boxSizing: 'border-box',
              border: 0,
              outline: 'none',
              // resize:none disables the user-drag handle (we drive height
              // programmatically via useAutoGrowTextarea); overflowY:auto puts
              // the scrollbar INSIDE the textarea once content exceeds the hook's
              // height cap, so the composer container stops pushing the feed up.
              resize: 'none',
              overflowY: 'auto',
              // Reserve the bottom-right corner for the floating send button so a
              // long last line wraps before it collides — the textarea equivalent of
              // NoteBubble's trailing-nbsp time reservation (a textarea can't hold nbsp).
              paddingRight: 34,
              fontFamily: isQuestion ? 'var(--font-serif)' : 'var(--font-sans)',
              fontStyle: isQuestion ? 'italic' : 'normal',
              fontSize: isQuestion ? 16 : 14,
              lineHeight: 1.5,
              color: 'var(--fg-0)',
              background: 'transparent',
            }}
          />
          {error && (
            <div
              role="alert"
              style={{
                marginTop: 6,
                paddingRight: 40,
                color: 'var(--status-wtf)',
                fontSize: 12,
                lineHeight: 1.4,
              }}
            >
              {error}
            </div>
          )}
          {/* Floating send button — bottom-right corner, like a posted note's inline
              timestamp. No dedicated toolbar row, so the card stays as short as the text. */}
          <div style={{ position: 'absolute', right: 8, bottom: 8 }}>
            <SendButton onClick={submit} label="send note" title="send ↵" />
          </div>
        </div>
      </div>
    </div>
  )
}
