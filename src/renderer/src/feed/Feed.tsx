import { useEffect, useRef } from 'react'
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso'
import type { Note } from '../../../shared/types'
import { NoteBubble } from './NoteBubble'

interface Props {
  notes: Note[]
  focusedId: string | null
  onFocus: (id: string) => void
  onWikilinkClick: (slug: string) => void
  resolveSlug?: (slug: string) => boolean
  onEdit: (id: string) => void
  onDelete: (id: string) => void
  onCopyLink: (id: string) => void
}

/**
 * Renders the rolling feed of notes — oldest at the top, newest at the bottom
 * — using vanilla `Virtuoso` from `react-virtuoso` (MIT). The commercial
 * `VirtuosoMessageList` is explicitly avoided per spec §Stack.
 *
 * Why `followOutput="auto"` + `alignToBottom`: chat-style reverse-scroll. When
 * the user is already pinned to the bottom and a new note arrives, Virtuoso
 * scrolls down so the new bubble enters view; if the user has scrolled up to
 * read older notes, their scroll position is preserved (spec §Feed —
 * "scroll snaps down on send"; users browsing history are not yanked).
 *
 * Why the `useEffect` watching `notes.length` (vs relying on `followOutput`
 * alone): `followOutput="auto"` only fires when the user is currently at the
 * bottom. When `notes` mutates from outside (e.g. a reconciler tick imports
 * an external edit while the user is scrolled up reading), we still want the
 * latest item visible; the imperative `scrollToIndex` with `behavior: 'smooth'`
 * + `align: 'end'` handles that case. `initialTopMostItemIndex` covers the
 * mount-time "start at the last bubble" requirement so the first paint is
 * already at the bottom — no scroll jump on load.
 *
 * The `resolveSlug` prop is forwarded with a conditional spread to satisfy
 * `exactOptionalPropertyTypes` — passing `undefined` explicitly is a type
 * error against the optional `resolveSlug?: (slug: string) => boolean` prop
 * on `NoteBubble`. Mirrors the pattern at `NoteBubble.tsx:112`.
 *
 * @see docs/specs/v0.1-rolling-feed-and-search.md §Feed
 * @see v21-design-system/project/ui_kits/v21-app/feed.jsx
 */
export function Feed({
  notes,
  focusedId,
  onFocus,
  onWikilinkClick,
  resolveSlug,
  onEdit,
  onDelete,
  onCopyLink,
}: Props) {
  const virtuoso = useRef<VirtuosoHandle | null>(null)
  const lastCount = useRef(notes.length)

  useEffect(() => {
    if (notes.length > lastCount.current) {
      virtuoso.current?.scrollToIndex({
        index: notes.length - 1,
        behavior: 'smooth',
        align: 'end',
      })
    }
    lastCount.current = notes.length
  }, [notes.length])

  return (
    <div style={{ flex: 1, minHeight: 0, padding: '0 32px' }}>
      <div style={{ maxWidth: 720, margin: '0 auto', height: '100%' }}>
        <Virtuoso
          ref={virtuoso}
          data={notes}
          initialTopMostItemIndex={{ index: Math.max(0, notes.length - 1), align: 'end' }}
          alignToBottom
          followOutput="auto"
          itemContent={(_, note) => (
            <NoteBubble
              note={note}
              focused={note.id === focusedId}
              onFocus={() => onFocus(note.id)}
              onWikilinkClick={onWikilinkClick}
              {...(resolveSlug ? { resolveSlug } : {})}
              onEdit={() => onEdit(note.id)}
              onDelete={() => onDelete(note.id)}
              onCopyLink={() => onCopyLink(note.id)}
            />
          )}
          style={{ height: '100%' }}
        />
      </div>
    </div>
  )
}
