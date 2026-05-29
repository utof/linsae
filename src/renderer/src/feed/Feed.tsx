import { useVirtualizer } from '@tanstack/react-virtual'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import type { Note } from '../../../shared/types'
import { ScrollThumb, useScrollThumb } from '../components/ScrollArea'
import { NoteBubble } from './NoteBubble'
import { useExpandCollapseMorph } from './useExpandCollapseMorph'

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

/** Returns a new Set with `id` toggled — immutable so React sees a new ref. */
function toggleSet(prev: ReadonlySet<string>, id: string): ReadonlySet<string> {
  const next = new Set(prev)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  return next
}

/** Immutable add — returns the same ref if already present (no needless render). */
function addId(prev: ReadonlySet<string>, id: string): ReadonlySet<string> {
  if (prev.has(id)) return prev
  const next = new Set(prev)
  next.add(id)
  return next
}

/** Immutable remove — returns the same ref if absent. */
function removeId(prev: ReadonlySet<string>, id: string): ReadonlySet<string> {
  if (!prev.has(id)) return prev
  const next = new Set(prev)
  next.delete(id)
  return next
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
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(() => new Set())

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
    // Rows rendered beyond the viewport on each side — tanstack's documented
    // lever for "slow-rendering blank items when scrolling": a scroll event
    // costs a recompute + re-render + paint, and a hard wheel flick can outrun
    // a thin buffer within that frame, exposing blank space. It's a tradeoff —
    // too low blanks on flicks, too high pays per-frame reconcile cost for the
    // off-screen bubbles. Pre-React-Compiler that ceiling forced ~12–16; with
    // the compiler skipping reconcile of unchanged bubbles (ADR 0006), 8 holds
    // 60fps even in dev with no blanking. Re-tune against `DevFpsMeter`, not by
    // feel. @see https://tanstack.com/virtual/latest/docs/api/virtualizer#overscan
    overscan: 8,
  })

  const [morphingIndex, setMorphingIndex] = useState<number | null>(null)
  const morphingIndexRef = useRef<number | null>(null)
  morphingIndexRef.current = morphingIndex
  const suppressThumbResizeRef = useRef<boolean>(false)
  const { run: runMorph, cancel: cancelMorph } = useExpandCollapseMorph({
    virtualizer,
    scrollerEl,
    setMorphingIndex,
    suppressThumbResizeRef,
  })

  // Prevent the virtualizer's own scroll-position correction from fighting
  // the manual bottom-anchor during an active morph. ADR 0007.
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = () => morphingIndexRef.current === null
  // shouldAdjust above does NOT gate virtual-core's `anchorTo:'end'` "wasAtEnd"
  // path: in resizeItem the `if (wasAtEnd) applyScrollAdjustment(...)` branch is
  // unconditional (dist/esm/index.js). When collapsing a note near the bottom,
  // that branch rides the scroll up by the size delta AT THE SAME TIME as our
  // manual bottom-anchor — double-applying, so the viewport overshoots above all
  // content and the feed blanks for the morph. Drop anchorTo to 'start' for the
  // morph window so OUR bottom-anchor is the only thing moving scroll; restore
  // 'end' after. (anchorTo is read live as this.options.anchorTo.) ADR 0007.
  virtualizer.options.anchorTo = morphingIndexRef.current === null ? 'end' : 'start'

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

  // Stable id-taking toggle (compiler-friendly; no per-item closure).
  //
  // The hard part of collapse is that swapping to truncated content first (the
  // naive approach) leaves the shrinking clip box taller than its now-short
  // content → an empty white band reads as "the note vanished". So we measure
  // the collapsed target up front via a no-paint `flushSync` swap, then keep the
  // FULL content mounted for the roll-up and only commit the truncation at the
  // morph's end (`onCommit`). The flushSyncs are in an event handler, so the
  // browser only paints after the handler returns — the intermediate renders
  // are never shown. See ADR 0007.
  const handleToggleExpand = useCallback(
    (id: string) => {
      cancelMorph()
      const scroller = scrollerEl
      const index = notes.findIndex((n) => n.id === id)
      const vItem = virtualizer.getVirtualItems().find((v) => v.index === index)
      const itemEl = scroller?.querySelector<HTMLElement>(`[data-index="${index}"]`) ?? null
      const bodyEl = itemEl?.querySelector<HTMLElement>('[data-bubble-body]') ?? null
      const collapsing = expandedIds.has(id)
      // Fallback: no scroller / element not currently rendered → just toggle.
      if (!scroller || !vItem || !itemEl || !bodyEl) {
        setExpandedIds((prev) => toggleSet(prev, id))
        return
      }
      const start = vItem.start
      const scrollTopStart = scroller.scrollTop

      // Detach measureElement + switch anchorTo to 'start' (render-body overrides
      // keyed on morphingIndex) BEFORE the measurement swaps, so they don't
      // trigger the virtualizer's own resize/scroll reactions.
      flushSync(() => setMorphingIndex(index))
      const startItemH = itemEl.getBoundingClientRect().height

      // Commit the END content to measure its true size + chrome.
      flushSync(() => setExpandedIds((prev) => (collapsing ? removeId(prev, id) : addId(prev, id))))
      const endItemH = itemEl.getBoundingClientRect().height
      const nonBodyH = endItemH - bodyEl.getBoundingClientRect().height
      // Collapse: restore FULL content so the roll-up animates over real text;
      // finish() re-commits the collapse. Expand: leave it expanded (end state).
      if (collapsing) flushSync(() => setExpandedIds((prev) => addId(prev, id)))

      runMorph(
        {
          index,
          start,
          startItemH,
          endItemH,
          nonBodyH,
          bottomScreenOffset: start + startItemH - scrollTopStart,
          collapsing,
        },
        bodyEl,
        collapsing ? () => setExpandedIds((prev) => removeId(prev, id)) : undefined,
      )
    },
    [notes, virtualizer, scrollerEl, expandedIds, cancelMorph, runMorph],
  )

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

  const thumb = useScrollThumb(scrollerEl, suppressThumbResizeRef)

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
                  // Detach measureElement while this item is morphing — the
                  // morph drives its size via resizeItem instead (ADR 0007;
                  // tanstack: don't use both on one item).
                  ref={vItem.index === morphingIndex ? undefined : virtualizer.measureElement}
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
                    expanded={expandedIds.has(note.id)}
                    onToggleExpand={handleToggleExpand}
                    // Pass the id-taking callbacks straight through — no
                    // per-item closures. NoteBubble binds them to its own
                    // note.id, which keeps its props referentially stable so
                    // the React Compiler's auto-memo lets it skip reconcile
                    // while it stays in the virtual window. See ADR 0006.
                    onFocus={onFocus}
                    onWikilinkClick={onWikilinkClick}
                    {...(resolveSlug ? { resolveSlug } : {})}
                    onEdit={onEdit}
                    onDelete={onDelete}
                    onCopyLink={onCopyLink}
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
