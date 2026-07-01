import { useState } from 'react'

/**
 * Minimal thread composer: Enter posts a comment-on child; no media chrome.
 *
 * Why: the YouTube ThreadComposer (~405 lines) is media-specific; plain/PDF
 * threads need only text-in. Enter sends (ADR 0001), Shift+Enter inserts a
 * newline. Trim-empty guard prevents blank posts.
 *
 * Styling mirrors `src/renderer/src/thread/ThreadComposer.tsx` textarea:
 * same v21 tokens (--font-sans, --fg-0, --border-1, --r-4, --shadow-2),
 * same font size (13px) and line-height (1.5). No hardcoded colors.
 *
 * @see docs/specs/v0.6.4-notes-as-threads.md
 * @see adrs/0001-enter-key-sends.md
 * @see src/renderer/src/thread/ThreadComposer.tsx (auto-grow + Enter-sends pattern)
 */
export function SimpleComposer({ onSubmit }: { onSubmit: (body: string) => void }) {
  const [body, setBody] = useState('')
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
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          // Enter sends (ADR 0001); Shift+Enter inserts a newline (browser default).
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            const t = body.trim()
            if (t) {
              onSubmit(t)
              setBody('')
            }
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
    </div>
  )
}
