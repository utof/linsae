import { type KeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { NoteType } from '../../../shared/types'

/**
 * Cap on the auto-grown textarea height. ~10 lines at 14px text + 1.5
 * line-height + the inner padding leaves a comfortable Telegram-style
 * draft window before the internal scrollbar kicks in. Past this, the
 * textarea overflow-scrolls inside itself; the composer container does
 * not push the feed any further upward.
 */
const TEXTAREA_MAX_HEIGHT_PX = 220

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
}: Props) {
  const [body, setBody] = useState(initialBody)
  const [mode, setMode] = useState<NoteType>(initialMode)
  const ref = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    ref.current?.focus()
  }, [])

  // Auto-grow: reset to 'auto' so scrollHeight reports the natural content
  // height (without this it monotonically grows), then clamp to the cap.
  // useLayoutEffect (not useEffect) runs synchronously after DOM mutation
  // and before paint, so users never see a one-frame flash of the old
  // height. Runs on initialBody too (edit mode arrives with prefilled text).
  // Cannot rely on `rows={...}` for the initial size now that we control
  // height directly — the textarea has no `rows` prop below. `body` is a
  // trigger-only dep: the effect reads el.scrollHeight via ref AFTER React
  // flushes the controlled value to the DOM. Without [body] in the deps the
  // resize would only fire on mount and the textarea would never grow.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see comment above
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, TEXTAREA_MAX_HEIGHT_PX)}px`
  }, [body])

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
        padding: '12px 32px 24px',
        background: 'var(--bg-0)',
        borderTop: '1px solid var(--border-0)',
      }}
    >
      <div style={{ maxWidth: 720, margin: '0 auto' }}>
        <div
          style={{
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
            aria-label={isQuestion ? 'ask a question' : 'write a note'}
            placeholder={isQuestion ? 'ask a question…' : 'write — or press ? for a question'}
            style={{
              width: '100%',
              border: 0,
              outline: 'none',
              // resize:none disables the user-drag handle (we drive height
              // programmatically via the useLayoutEffect above);
              // overflowY:auto puts the scrollbar INSIDE the textarea once
              // content exceeds TEXTAREA_MAX_HEIGHT_PX, so the composer
              // container stops pushing the feed up.
              resize: 'none',
              overflowY: 'auto',
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
                color: 'var(--status-wtf)',
                fontSize: 12,
                lineHeight: 1.4,
              }}
            >
              {error}
            </div>
          )}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 14,
              paddingTop: 6,
              borderTop: '1px dashed var(--border-0)',
              marginTop: 4,
              fontSize: 11,
              color: 'var(--fg-3)',
            }}
          >
            <span>↵ send · ⇧↵ newline · ⌘K search</span>
          </div>
        </div>
      </div>
    </div>
  )
}
