import { useState } from 'react'
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
export function SimpleComposer({ onSubmit }: { onSubmit: (body: string) => void }) {
  const [body, setBody] = useState('')
  const ref = useAutoGrowTextarea(body)

  // Submit path shared by Enter and the send button. Trim-empty guard: a
  // whitespace-only draft is a no-op. On a real post, clear the draft.
  const submit = () => {
    const t = body.trim()
    if (t) {
      onSubmit(t)
      setBody('')
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
