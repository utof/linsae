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
 * bottom. When the list grows from outside (e.g. a reconciler tick adds an
 * externally-created note while the user is scrolled up reading), we still
 * want the new tail visible; the imperative `scrollToIndex` handles that.
 * The `>` (not `!==`) comparison deliberately narrows to additions only:
 * deletes shouldn't yank the viewport, and edits that swap a note for
 * another at the same index aren't flagged here (same-length, identity
 * change). `initialTopMostItemIndex` covers the mount-time "start at the
 * last bubble" requirement so the first paint is already at the bottom.
 *
 * Why `computeItemKey={(_, note) => note.id}`: default vanilla-Virtuoso keys
 * by array index, which under delete/reorder would let downstream bubbles
 * reuse the wrong DOM node — leaking `NoteBubble`'s internal `useState`
 * (`hover`, `deleteArmed`) and `armTimer` ref across notes. uuidv7 ids are
 * stable per note, so keying by id makes React mount/unmount correctly.
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
  const containerRef = useRef<HTMLDivElement | null>(null)
  // Track whether the user is currently pinned to the bottom of the feed.
  // Updated by Virtuoso's atBottomStateChange. Used by the ResizeObserver
  // below to decide whether to re-pin after the container shrinks (e.g.
  // when the composer auto-grows). Default true matches initialTopMostItemIndex.
  const atBottomRef = useRef(true)
  // Mirror notes.length into a ref so the ResizeObserver callback (created
  // once on mount) can read the latest index without re-binding.
  const lastIndexRef = useRef(notes.length - 1)

  useEffect(() => {
    if (notes.length > lastCount.current) {
      virtuoso.current?.scrollToIndex({
        index: notes.length - 1,
        behavior: 'smooth',
        align: 'end',
      })
    }
    lastCount.current = notes.length
    lastIndexRef.current = notes.length - 1
  }, [notes.length])

  // Re-pin the latest note to the bottom whenever the feed's container
  // height changes (the composer just auto-grew via shift-Enter, the
  // window was resized, the skip-banner appeared/dismissed). Virtuoso's
  // default behaviour preserves the top-edge scroll offset on resize, so
  // bottom items silently get pushed out of view — defeating the
  // chat-style "latest is always visible when I'm at the bottom" contract.
  // Guarded on atBottomRef so a user scrolled up reading history is NOT
  // yanked back down.
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      if (atBottomRef.current && lastIndexRef.current >= 0) {
        virtuoso.current?.scrollToIndex({
          index: lastIndexRef.current,
          align: 'end',
        })
      }
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  return (
    <div ref={containerRef} style={{ flex: 1, minHeight: 0, padding: '0 32px' }}>
      <div style={{ maxWidth: 720, margin: '0 auto', height: '100%' }}>
        <Virtuoso
          ref={virtuoso}
          data={notes}
          computeItemKey={(_, note) => note.id}
          initialTopMostItemIndex={{ index: Math.max(0, notes.length - 1), align: 'end' }}
          alignToBottom
          followOutput="auto"
          atBottomStateChange={(b) => {
            atBottomRef.current = b
          }}
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
