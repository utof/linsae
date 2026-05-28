import { useEffect, useMemo, useRef, useState } from 'react'
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
 * Why `alignToBottom` only (no `followOutput`): we own scroll-on-grow
 * imperatively in the notes.length useEffect below. `followOutput="auto"`
 * would race with that, and historically called Virtuoso's `scrollToIndex`
 * — fine now that bubble margin moved into the itemContent wrapper's
 * padding (sizes are accurate), but two scroll-setters fighting on every
 * send caused visible teleport-up flashes. `initialTopMostItemIndex`
 * covers the mount-time "start at the last bubble" requirement so the
 * first paint is already at the bottom.
 *
 * Why the `useEffect` watching `notes.length`: imperatively pins to the
 * true bottom on send when the user is near-bottom. Direct `scrollTop =
 * scrollHeight` is more robust than Virtuoso's scrollToIndex even with
 * accurate sizes (no animation jitter, no cache-staleness window). Guarded
 * on a near-bottom distance check so a user scrolled up reading history
 * is NOT yanked when a new note arrives. The `>` (not `!==`) comparison
 * deliberately narrows to additions only: deletes shouldn't yank the
 * viewport, and edits that swap a note for another at the same index
 * aren't flagged here (same-length, identity change).
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

  // Per-item size estimates Virtuoso uses to build its initial size tree
  // BEFORE measurement. Without these, unmeasured items use a wild
  // placeholder estimate (a diagnostic log capture showed it allocating
  // ~1812 px for one short bubble — see commit b35d293 message) that
  // inflates total scrollHeight and makes the custom thumb start small +
  // collapse to correct sizing only as items are scrolled into view.
  //
  // The estimate must account for the BODY_TRUNCATE_AT=4096 cap in
  // NoteBubble: a 10k-char note actually paints only its first 4096 chars
  // + an expand-button row, so estimating from `body.length` directly
  // over-counts for long notes by ~2x and causes the thumb to jump when
  // the user scrolls one such bubble into view and Virtuoso re-measures
  // it down to the true size. Cap the input length to mirror the bubble.
  //
  //   - 26 px = wrapper padding (12) + bubble border (2) + bubble padding (12)
  //   - 22 px / line at our 14px font + 560 px max-width (~70 chars / line)
  //   - +18 px for the bottom flex row (expand button + timestamp) when overCap
  //
  // Must stay in sync with `BODY_TRUNCATE_AT` in NoteBubble.tsx — repeated
  // here rather than imported because exporting a UI-internal constant for
  // one consumer wastes more API surface than this 6-character duplicate.
  const heightEstimates = useMemo(() => {
    const RENDER_CAP = 4096
    return notes.map((n) => {
      const overCap = n.body.length > RENDER_CAP
      const renderedLen = overCap ? RENDER_CAP : n.body.length
      const newlineLines = (n.body.match(/\n/g)?.length ?? 0) + 1
      const wrapLines = Math.ceil(renderedLen / 70)
      const lines = Math.max(1, Math.min(newlineLines, RENDER_CAP), wrapLines)
      return 26 + lines * 22 + (overCap ? 18 : 0)
    })
  }, [notes])

  // Re-pin to bottom when notes grow, but only if the user is near the
  // bottom. Direct `scrollTop = scrollHeight` (not Virtuoso's scrollToIndex)
  // bypasses the per-item size-cache undershoot — see the ResizeObserver
  // effect below for the full rationale. The 120px near-bottom threshold is
  // generous on purpose: a user who's drifted ~one bubble height up while
  // skimming the latest still wants the new send pulled into view, while a
  // user genuinely browsing older notes (well past 120px) is left alone.
  // Double rAF: Virtuoso hasn't materialized the new item yet at the
  // useEffect tick — the first rAF lets it commit DOM, the second catches
  // its size-cache update so scrollHeight reflects the truly-new bottom.
  useEffect(() => {
    if (notes.length > lastCount.current) {
      const scroller = scrollerRef.current
      if (scroller) {
        const distance = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight
        if (distance < 120) {
          requestAnimationFrame(() => {
            scroller.scrollTop = scroller.scrollHeight
            requestAnimationFrame(() => {
              scroller.scrollTop = scroller.scrollHeight
            })
          })
        }
      }
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
      // Direct `scrollTop = scrollHeight` (not Virtuoso's scrollToIndex)
      // because the latter animates and runs through its own size cache,
      // both of which can race the rapid resize tick. The native scroll
      // extent always lands on the true painted bottom.
      scroller.scrollTop = scroller.scrollHeight
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Suppress the benign "ResizeObserver loop completed with undelivered
  // notifications" error that surfaces when `skipAnimationFrameInResizeObserver`
  // is on (the prop tightens the measure→paint loop, which is exactly why
  // it sometimes trips this loop-detection warning). Browsers raise it as
  // an `error` event on window but it's harmless — petyosi documents the
  // suppression alongside the prop. @see
  // https://github.com/petyosi/react-virtuoso/issues/1049
  useEffect(() => {
    const onError = (e: ErrorEvent) => {
      if (e.message === 'ResizeObserver loop completed with undelivered notifications.') {
        e.stopImmediatePropagation()
        e.preventDefault()
      }
    }
    window.addEventListener('error', onError)
    return () => window.removeEventListener('error', onError)
  }, [])

  return (
    <div
      ref={containerRef}
      onPointerEnter={thumb.onAreaEnter}
      onPointerLeave={thumb.onAreaLeave}
      onPointerMove={thumb.onAreaPointerMove}
      style={{ flex: 1, minHeight: 0, padding: '0 32px' }}
    >
      <div style={{ maxWidth: 720, margin: '0 auto', height: '100%', position: 'relative' }}>
        <Virtuoso
          ref={virtuoso}
          data={notes}
          computeItemKey={(_, note) => note.id}
          initialTopMostItemIndex={{ index: Math.max(0, notes.length - 1), align: 'end' }}
          alignToBottom
          heightEstimates={heightEstimates}
          // Skip the rAF wrapper around Virtuoso's internal ResizeObserver
          // callback. Undocumented prop added in v4.9.0 (see TSDoc at
          // node_modules/.../react-virtuoso/dist/index.d.ts:1906-1909). The
          // OSS Virtuoso fundamentally cannot deliver a stable scrollHeight
          // for chat-style variable-content lists (maintainer confirmed at
          // petyosi/react-virtuoso#1240, #131, #428, #1382); this flag is the
          // closest in-OSS mitigation — it tightens the measure→paint loop,
          // which the discussion thread #1083 confirms reduces (not
          // eliminates) the estimate→measure scrollHeight flicker. Trade-off:
          // can trigger a benign "ResizeObserver loop completed" warning;
          // suppressed by the window-error listener above.
          skipAnimationFrameInResizeObserver
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
            // Vertical gap lives here as padding (not on the bubble as margin)
            // so Virtuoso's per-item size cache — read from this wrapper's
            // border-box — accounts for it. Margin on the bubble would sit
            // outside content-box and silently under-report scrollHeight by
            // ~6px per bubble, breaking scrollToIndex / followOutput and
            // letting the browser clamp scrollTop mid-scroll ("teleport up").
            <div style={{ paddingTop: 6, paddingBottom: 6 }}>
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
            </div>
          )}
          style={{ height: '100%' }}
        />
        <ScrollThumb
          geometry={thumb.geometry}
          thumbHovered={thumb.thumbHovered}
          areaHovered={thumb.areaHovered}
          pointerNear={thumb.pointerNear}
          resizing={thumb.resizing}
          dragging={thumb.dragging}
          setThumbHovered={thumb.setThumbHovered}
          onPointerDown={thumb.onThumbPointerDown}
        />
      </div>
    </div>
  )
}
