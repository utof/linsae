import type { Note } from '../../../shared/types'
import { Markdown } from '../lib/markdown'

interface Props {
  /** The root note whose body is displayed as the thread header. */
  note: Note
}

/**
 * Header section for a plain-note thread — renders the root note's body using
 * the codebase's standard Markdown pipeline (GFM + wikilinks + timestamps).
 *
 * Why this component exists: `ThreadView` needs a type-specific header for
 * plain-note threads. Media threads (YouTube / PDF) provide their own header
 * (the player / docked reader), so `ThreadRoot` is ONLY for plain notes.
 *
 * Why `Markdown` directly (not `NoteBubble`): `NoteBubble` carries ~10 required
 * props (focused, expanded, onToggleExpand, onFocus, onWikilinkClick, onEdit,
 * onDelete, onCopyLink) oriented toward the interactive feed. `ThreadRoot` is
 * read-only and needs only the rendered body. Using `Markdown` directly is the
 * minimal, YAGNI path that still runs the same render pipeline.
 *
 * Why no-op `onWikilinkClick`: wikilink navigation is the caller's concern.
 * The header is read-only at v0.6.4; navigation can be threaded in later when
 * `ThreadView` wires up an app-level navigator.
 *
 * @see src/renderer/src/thread/ThreadView.tsx
 * @see docs/plans/v0.6.4-notes-as-threads.md §Task 2.2
 */
export function ThreadRoot({ note }: Props) {
  return (
    <div
      style={{
        padding: '12px 16px',
        borderBottom: '1px solid var(--border-0)',
        fontSize: 16,
        color: 'var(--fg-0)',
        fontFamily: 'var(--font-sans)',
      }}
    >
      <Markdown body={note.body} onWikilinkClick={() => {}} />
    </div>
  )
}
