import { type KeyboardEvent, useEffect, useRef, useState } from 'react'
import type { NoteType } from '../../../shared/types'

interface Props {
  onSubmit: (input: { body: string; type: NoteType }) => void
  onCancel: () => void
  initialBody: string
  initialMode: NoteType
  editMode?: boolean
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
}: Props) {
  const [body, setBody] = useState(initialBody)
  const [mode, setMode] = useState<NoteType>(initialMode)
  const ref = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    ref.current?.focus()
  }, [])

  const submit = () => {
    if (!body.trim()) return
    onSubmit({ body, type: mode })
    setBody('')
    setMode('claim')
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

  const accent = mode === 'question' ? 'var(--type-question)' : 'var(--border-1)'

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
            border: `1px solid ${accent}`,
            borderRadius: 10,
            boxShadow: 'var(--shadow-2)',
            padding: '10px 12px 8px',
          }}
        >
          {mode === 'question' && (
            <div
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                marginBottom: 6,
                padding: '2px 8px',
                borderRadius: 2,
                background: accent,
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
            onChange={(e) => setBody(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={
              mode === 'question' ? 'ask a question…' : 'write — or press ? for a question'
            }
            rows={mode === 'question' ? 2 : 1}
            style={{
              width: '100%',
              border: 0,
              outline: 'none',
              resize: 'none',
              fontFamily: mode === 'question' ? 'var(--font-serif)' : 'var(--font-sans)',
              fontStyle: mode === 'question' ? 'italic' : 'normal',
              fontSize: mode === 'question' ? 16 : 14,
              lineHeight: 1.5,
              color: 'var(--fg-0)',
              background: 'transparent',
            }}
          />
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
