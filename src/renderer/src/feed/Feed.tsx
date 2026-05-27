import { useEffect, useRef, useState } from 'react'
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso'
import type { Note } from '../../../shared/types'
import { ScrollThumb, useScrollThumb } from '../components/ScrollArea'
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
  // Inner scrollable element that Virtuoso renders. Captured via the
  // scrollerRef callback below so we can attach a `scroll` listener for our
  // own at-bottom tracking (see atBottomRef comment).
  const scrollerRef = useRef<HTMLElement | null>(null)
  // State mirror of scrollerRef so the useScrollThumb hook (below) re-runs
  // its effect when Virtuoso captures its scroller on the second render
  // pass. Plain refs don't trigger re-renders; state does.
  const [scrollerEl, setScrollerEl] = useState<HTMLElement | null>(null)
  const thumb = useScrollThumb(scrollerEl)
  // Whether the user is currently pinned to the bottom of the feed.
  //
  // We do NOT use Virtuoso's `atBottomStateChange` callback because of a
  // race that breaks the composer-grow case: when the composer auto-grows,
  // the feed container shrinks via flex; Virtuoso's internal ResizeObserver
  // fires FIRST (child useEffects run before parent's, so its observer was
  // registered earlier), recomputes at-bottom (now `false` because the
  // bottom items just got hidden), and synchronously fires
  // `atBottomStateChange(false)`. By the time our own ResizeObserver fires
  // next, the ref is already `false` and the re-pin guard fails — the
  // latest bubble stays clipped.
  //
  // Instead we maintain the ref ourselves from `scroll` events on the
  // inner scroller. The browser does NOT fire a `scroll` event on resize
  // (scrollTop stays put even if the user is visually no longer at the
  // bottom), so the ref accurately reflects the user's PRE-resize position
  // — exactly the signal the re-pin guard needs.
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

  // User-driven at-bottom tracking. Fires only on actual scroll events
  // (wheel / trackpad / drag / programmatic scrollToIndex), never on
  // container resize — see atBottomRef comment for why this matters.
  // Re-binds when scroller becomes available (Virtuoso may render the
  // inner scroller on its second pass, so scrollerRef.current can be
  // null on the first effect run).
  useEffect(() => {
    const scroller = scrollerRef.current
    if (!scroller) return
    const update = () => {
      // 10px slack: rounding + virtualization gaps can leave a sub-pixel
      // difference even when visually "at the bottom".
      atBottomRef.current = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 10
    }
    update()
    scroller.addEventListener('scroll', update, { passive: true })
    return () => scroller.removeEventListener('scroll', update)
  }, [])

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
      const scroller = scrollerRef.current
      if (!scroller || !atBottomRef.current) return
      // Bypass Virtuoso's `scrollToIndex({align:'end'})` — its per-item size
      // cache is systematically UNDER-reported because:
      //   - NoteBubble's root div has `margin: '6px 0'`
      //   - the react-markdown subtree emits <p>/<ul>/<pre> with default
      //     browser margins, untreated by globals.css
      // and Virtuoso sizes items via ResizeObserver.contentRect, which
      // EXCLUDES margins. The computed end position therefore lands short
      // of the true bottom — the latest bubble stays clipped below the
      // viewport regardless of how correct our at-bottom guard is.
      //
      // Direct `scrollTop = scrollHeight` uses the browser's native scroll
      // extent (which DOES respect margins via actual painted bounds),
      // hitting the true bottom every time.
      // @see https://virtuoso.dev/react-virtuoso/troubleshooting
      //      ("List does not scroll to the bottom / items jump around")
      scroller.scrollTop = scroller.scrollHeight
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  return (
    <div
      ref={containerRef}
      onPointerEnter={thumb.onAreaEnter}
      onPointerLeave={thumb.onAreaLeave}
      style={{ flex: 1, minHeight: 0, padding: '0 32px' }}
    >
      <div style={{ maxWidth: 720, margin: '0 auto', height: '100%', position: 'relative' }}>
        <Virtuoso
          ref={virtuoso}
          data={notes}
          computeItemKey={(_, note) => note.id}
          initialTopMostItemIndex={{ index: Math.max(0, notes.length - 1), align: 'end' }}
          alignToBottom
          followOutput="auto"
          scrollerRef={(el) => {
            const node = el as HTMLElement | null
            scrollerRef.current = node
            setScrollerEl(node)
            // Hide Virtuoso's native scrollbar — the custom thumb above
            // owns visibility. .scroll-area-inner globals.css rule covers
            // ::-webkit-scrollbar; inline scrollbarWidth covers Firefox.
            if (node) {
              node.classList.add('scroll-area-inner')
              node.style.scrollbarWidth = 'none'
            }
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
        <ScrollThumb
          geometry={thumb.geometry}
          thumbHovered={thumb.thumbHovered}
          areaHovered={thumb.areaHovered}
          setThumbHovered={thumb.setThumbHovered}
          onPointerDown={thumb.onThumbPointerDown}
        />
      </div>
    </div>
  )
}
