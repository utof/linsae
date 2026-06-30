import type { Note } from '../../../shared/types'
import { Markdown } from '../lib/markdown'

interface Props {
  /** The root note whose body is displayed as the thread header. */
  note: Note
  /**
   * Called when the user clicks a `[[wikilink]]` in the root body.
   * Defaults to a no-op so existing callers (tests, snapshots) work without
   * the prop. `ThreadView` passes the same resolver the feed uses so wikilinks
   * in the root header navigate correctly — satisfying spec §"Wikilink
   * navigation in thread cards".
   *
   * Why optional (not required): keeps `ThreadRoot.test.tsx` passing without
   * change and reduces the prop-surface for callers that render the header
   * in a read-only context.
   *
   * @see src/renderer/src/lib/markdown.tsx (onWikilinkClick signature)
   */
  onWikilinkClick?: (slug: string) => void
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
 * @see src/renderer/src/thread/ThreadView.tsx
 * @see docs/plans/v0.6.4-notes-as-threads.md §Task 2.2
 * @see docs/plans/v0.6.4-notes-as-threads.md §Task 2.3 (carry-forward: real wikilink handler)
 */
export function ThreadRoot({ note, onWikilinkClick }: Props) {
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
      <Markdown body={note.body} onWikilinkClick={onWikilinkClick ?? (() => {})} />
    </div>
  )
}
