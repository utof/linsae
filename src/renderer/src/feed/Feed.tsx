import { useVirtualizer } from '@tanstack/react-virtual'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
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
 * Content-aware per-bubble height estimate (px) for not-yet-measured items.
 * tanstack-virtual seeds its size tree with this, then replaces each entry
 * with the real `measureElement`-reported value once the bubble paints.
 *
 * Why content-aware and not a flat constant: the estimate is what positions
 * UNMEASURED items, and during a fast scroll the user blows past a run of
 * never-measured bubbles in a single frame. A flat 80 px under-counts every
 * multi-line note, so the rendered window spans far fewer real pixels than
 * the wheel just travelled — the virtualizer renders items for the wrong
 * region and the viewport shows blank until measurement catches up. Sizing
 * the estimate to the note body keeps the unmeasured size-tree close enough
 * to reality that the rendered window lands where the user actually scrolled.
 *
 * The model mirrors `NoteBubble`'s layout: ~26 px chrome (padding + border +
 * timestamp row), 22 px per rendered line (newline-driven OR ~70-char wrap,
 * whichever is larger), plus 18 px for the expand control on over-cap notes.
 * Order-of-magnitude correctness is enough — exact heights arrive via
 * `measureElement` on first paint and the inner container's CSS height then
 * equals the virtualizer's exact total, so scroll-anchoring stays stable.
 */
function estimateBubbleHeight(body: string): number {
  const RENDER_CAP = 4096
  const overCap = body.length > RENDER_CAP
  const renderedLen = overCap ? RENDER_CAP : body.length
  const newlineLines = (body.match(/\n/g)?.length ?? 0) + 1
  const wrapLines = Math.ceil(renderedLen / 70)
  const lines = Math.max(1, Math.min(newlineLines, RENDER_CAP), wrapLines)
  return 26 + lines * 22 + (overCap ? 18 : 0)
}

/**
 * Distance (px) below which the user counts as "at the end" for
 * `followOnAppend` and the container-resize re-pin. Matches the saga's
 * 120 px threshold from the previous Virtuoso implementation: a user
 * within ~one bubble of the bottom still wants new sends pulled into
 * view; a user well past 120 px is browsing history and shouldn't be
 * yanked.
 */
const SCROLL_END_THRESHOLD = 120

/**
 * Renders the rolling feed of notes — oldest at the top, newest at the
 * bottom — using `@tanstack/react-virtual`'s headless virtualizer with
 * its chat-shaped `anchorTo: 'end'` mode.
 *
 * Why tanstack-virtual (vs. `react-virtuoso` MIT): the OSS Virtuoso
 * `scrollHeight` swaps estimates for real measured sizes as items enter
 * viewport, which jerks the custom scrollbar thumb AND races
 * `alignToBottom`'s anchor reconciliation to produce visible scroll
 * teleports. Maintainer-confirmed at petyosi/react-virtuoso#1240 as a
 * limitation only addressed in the commercial `VirtuosoMessageList`.
 * tanstack-virtual exposes a precise `getTotalSize()` that the inner
 * container's CSS height equals exactly, so the browser's native scroll
 * anchoring keeps visible content stable through off-screen
 * measurements. See ADR 0005 for the full migration rationale.
 *
 * Chat-specific behaviour comes from three virtualizer options:
 * - `anchorTo: 'end'` keeps prepended history items visually stable
 *   (older messages loaded above the viewport do NOT shift visible
 *   content); also keeps streaming/growing tail-items pinned to the
 *   bottom when the user was at the end before the growth.
 * - `followOnAppend: true` auto-scrolls to the newly-appended item only
 *   when the user is within `scrollEndThreshold` of the end. If they're
 *   browsing history, appended items don't yank them away.
 * - `scrollEndThreshold` defines how close to the end counts as
 *   "pinned" (px from bottom).
 *
 * Initial scroll-to-bottom uses `virtualizer.scrollToEnd()` from a
 * `useLayoutEffect` so the first paint already lands at the bottom — no
 * cosmetic mid-mount jump.
 *
 * Container-resize re-pin: when the composer auto-grows or the window
 * resizes, the scroller's `clientHeight` shrinks. `followOnAppend`
 * doesn't fire (no append), so we observe `containerRef` ourselves and
 * call `scrollToEnd()` if the user was already at the end.
 *
 * The scroller ref callback is `useCallback`-memoized per ADR 0004 —
 * React 19's stricter ref-callback semantics treat identity changes as
 * detach + reattach. That ADR was written for Virtuoso's internal
 * cascade; the same React 19 footgun applies anywhere we attach a ref
 * callback to a child that wires the element into effects.
 *
 * @see adrs/0005-tanstack-virtual.md
 * @see docs/specs/v0.1-rolling-feed-and-search.md §Feed
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
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [scrollerEl, setScrollerEl] = useState<HTMLDivElement | null>(null)

  const virtualizer = useVirtualizer({
    count: notes.length,
    getScrollElement: () => scrollerEl,
    estimateSize: (index) => estimateBubbleHeight(notes[index]?.body ?? ''),
    // Stable key per note (uuidv7 id). Critical for prepend stability under
    // `anchorTo: 'end'`: tanstack captures the visible item by key before a
    // data change, finds the same keyed item after, and adjusts scrollTop
    // so the message stays in place. Index-keyed items can't survive a
    // prepend — every item's index shifts.
    getItemKey: (index) => notes[index]?.id ?? index,
    anchorTo: 'end',
    followOnAppend: true,
    scrollEndThreshold: SCROLL_END_THRESHOLD,
    // Rows rendered beyond the viewport on each side. tanstack's docs name
    // this the lever for "slow-rendering blank items at the top and bottom
    // when scrolling": a scroll event must recompute the range, re-render,
    // and paint — at least a frame of latency — and a fast wheel flick can
    // travel past a small buffer within that frame, exposing blank space.
    // A trackpad/thumb drag moves only a few px per frame so it never
    // outruns the buffer, which is why the gap only showed on hard wheel
    // flicks. 16 (up from 5) pre-mounts ~1k+ px of bubbles each side so the
    // exposed region is already painted before the user reaches it.
    // @see https://tanstack.com/virtual/latest/docs/api/virtualizer#overscan
    overscan: 16,
  })

  // Initial scroll-to-bottom once the scroller is available. Layout
  // effect (not effect) so the bottom-pinned position is set BEFORE the
  // browser paints — no first-frame flash at the top.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally one-shot; depends on `virtualizer` instance identity (stable across renders) and the boolean availability of `scrollerEl`
  useLayoutEffect(() => {
    if (scrollerEl && notes.length > 0) {
      virtualizer.scrollToEnd()
    }
  }, [scrollerEl])

  // Re-pin to the bottom when the feed container resizes AND the user
  // was already at the end. `followOnAppend` only fires on data change,
  // not on container resize (composer auto-grew via shift-Enter, window
  // resized, skip-banner appeared/dismissed), so we observe the outer
  // container ourselves. `isAtEnd()` uses the same `scrollEndThreshold`
  // configured above.
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      if (virtualizer.isAtEnd()) {
        virtualizer.scrollToEnd()
      }
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [virtualizer])

  // Memoized ref callback per ADR 0004 (React 19 ref-callback identity).
  // Captures only refs, a setState setter, and side-effect calls that
  // touch the DOM directly — `[]` deps are correct.
  const handleScrollerRef = useCallback((el: HTMLDivElement | null) => {
    setScrollerEl(el)
    if (el) {
      // Hide native scrollbar — the custom thumb owns visibility.
      // `.scroll-area-inner` in globals.css covers ::-webkit-scrollbar;
      // inline scrollbarWidth covers Firefox.
      el.classList.add('scroll-area-inner')
      el.style.scrollbarWidth = 'none'
    }
  }, [])

  const thumb = useScrollThumb(scrollerEl)

  return (
    <div
      ref={containerRef}
      onPointerEnter={thumb.onAreaEnter}
      onPointerLeave={thumb.onAreaLeave}
      onPointerMove={thumb.onAreaPointerMove}
      style={{ flex: 1, minHeight: 0, padding: '0 32px' }}
    >
      <div style={{ maxWidth: 720, margin: '0 auto', height: '100%', position: 'relative' }}>
        <div
          ref={handleScrollerRef}
          style={{ height: '100%', overflowY: 'auto', overflowX: 'hidden' }}
        >
          {/* Inner spacer: tanstack-virtual sets this element's height to
             the exact total content size (sum of measured sizes plus
             estimates for unmeasured items). The browser's `scrollHeight`
             on the outer scroller equals this inner height — that's what
             makes the custom scrollbar thumb stable. */}
          <div
            style={{
              height: virtualizer.getTotalSize(),
              width: '100%',
              position: 'relative',
            }}
          >
            {virtualizer.getVirtualItems().map((vItem) => {
              const note = notes[vItem.index]
              if (!note) return null
              return (
                <div
                  key={vItem.key}
                  ref={virtualizer.measureElement}
                  data-index={vItem.index}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    transform: `translateY(${vItem.start}px)`,
                    // Inter-bubble vertical gap as wrapper padding (not
                    // margin) so tanstack's `measureElement` reads a
                    // border-box height that already includes the gap.
                    // Same rationale as `6564a3d` carried forward.
                    paddingTop: 6,
                    paddingBottom: 6,
                  }}
                >
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
              )
            })}
          </div>
        </div>
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
