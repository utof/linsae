import { useVirtualizer } from '@tanstack/react-virtual'
import { type Ref, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import type { Note } from '../../../shared/types'
import { ScrollThumb, useScrollThumb } from '../components/ScrollArea'
import { dayKey, formatDayLabel } from '../lib/day'
import { DayDivider, ScrollDatePill } from './DatePills'
import { NoteBubble } from './NoteBubble'
import { useAppendReveal } from './useAppendReveal'
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
  /** Called when the user opens the thread panel for a source note. */
  onOpenThread?: (id: string) => void
  /**
   * Optional ref to the inner scroller element. Merged into the existing internal
   * scroller setup inside `handleScrollerRef`, never as a second JSX ref, so the
   * memoized-callback identity (ADR 0004) is preserved.
   *
   * @see adrs/0004-memoize-virtuoso-prop-callbacks.md
   */
  scrollerRef?: Ref<HTMLDivElement>
  /**
   * True from the moment the user submits a new note until shortly after it has
   * glided into place (App owns it via `beginSend`). The feed reads it to suppress
   * the virtualizer's own auto-scroll (`anchorTo:'end'` / `followOnAppend`) so the
   * make-room scroll-glide (`useAppendReveal`) owns the scroll while the note rises
   * in — without it, the new row's first measure rides the scroll up and rapid sends
   * desync the rendered range (the #66 white wall). No ghost (ADR 0020).
   */
  sendInFlight?: boolean
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
/**
 * Height estimate (px) for a YouTube source-note card in the feed.
 *
 * Breakdown: 16:9 thumbnail at card width 360px → ~202px + title row ~36px +
 * meta/timestamp row ~28px + hairline + bottom-row button ~44px = ~310px total.
 * The virtualizer re-measures on first paint, so this estimate only needs to be
 * close enough to avoid a visible scroll jump when the item is first virtualised.
 *
 * Why: `estimateBubbleHeight` comment explains close estimates prevent blank
 * frames on fast scroll.
 */
const SOURCE_NOTE_HEIGHT_ESTIMATE = 320

function estimateBubbleHeight(note: Note): number {
  // Source notes render a fixed-height media card — use a constant estimate.
  // The virtualizer replaces this with the measured value on first paint.
  if (note.source_kind === 'youtube' && note.source_locator?.video_id != null) {
    return SOURCE_NOTE_HEIGHT_ESTIMATE
  }
  const body = note.body
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
 * Height (px) the inline {@link DayDivider} adds to a first-of-day item's wrapper.
 * Seeds the virtualizer's size estimate for unmeasured day-boundary items (the real
 * height arrives via measureElement on first paint) and defines the top zone within
 * which an incoming divider pushes the floating scroll pill out.
 */
const DAY_DIVIDER_H = 34

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
  onOpenThread,
  scrollerRef,
  sendInFlight = false,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)
  const [scrollerEl, setScrollerEl] = useState<HTMLDivElement | null>(null)
  // Holder for the external scrollerRef so `handleScrollerRef` can stay
  // `[]`-memoized (ADR 0004): reading a ref of stable identity inside the
  // callback avoids putting the changing `scrollerRef` prop in its deps.
  const externalScrollerRef = useRef<Ref<HTMLDivElement> | undefined>(scrollerRef)
  externalScrollerRef.current = scrollerRef
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(() => new Set())

  // Indices that begin a new calendar day → an inline DayDivider renders above them
  // and their size estimate gains DAY_DIVIDER_H. Recomputed only when the list changes.
  const dayFirsts = useMemo(() => {
    const set = new Set<number>()
    let prevKey: string | null = null
    notes.forEach((n, i) => {
      const k = dayKey(n.created_at)
      if (k !== prevKey) set.add(i)
      prevKey = k
    })
    return set
  }, [notes])

  const virtualizer = useVirtualizer({
    count: notes.length,
    getScrollElement: () => scrollerEl,
    estimateSize: (index) => {
      const n = notes[index]
      const base = n ? estimateBubbleHeight(n) : 80
      return dayFirsts.has(index) ? base + DAY_DIVIDER_H : base
    },
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
  // `revealing` is true while the make-room reveal (useAppendReveal) slides a
  // freshly-sent note up into place by translating the content wrapper. Like
  // `morphingIndex` it gates the virtualizer's scroll-correction below (so a
  // measure correction can't jump scrollTop out from under the transform); the
  // ref is read live in the `shouldAdjust` closure, the state forces the
  // anchorTo re-apply.
  const [revealing, setRevealing] = useState(false)
  const revealingRef = useRef(false)
  // Collapsed-state geometry (item height + constant chrome), captured for free
  // when a note is EXPANDED — at that instant the note is still rendered
  // collapsed, so its pre-swap layout IS the collapse target. Reused on collapse
  // so we DON'T re-render the heavy `<Markdown>` (full markdown + KaTeX) just to
  // measure: the old full→truncated→full measure-swap froze the animation for
  // hundreds of ms on KaTeX-heavy notes in dev (#48, #50). `expandedIds` is
  // ephemeral, so every collapse follows an expand this session → the cache is
  // populated; the measure-swap stays as a fallback. Stale geometry (resize/edit
  // between expand and collapse) is reconciled by the morph's final remeasure.
  const collapsedGeomRef = useRef<Map<string, { itemH: number; nonBodyH: number }>>(new Map())
  const { run: runMorph, cancel: cancelMorph } = useExpandCollapseMorph({
    virtualizer,
    scrollerEl,
    setMorphingIndex,
    suppressThumbResizeRef,
  })
  // iMessage make-room: a freshly-sent note pushes the whole feed up as it glides
  // into place at the bottom, instead of popping in. It animates `scrollTop`
  // directly (no scrollTop fight — ADR 0019), so the note rises into view. There is
  // no flying ghost: the note is its own entrance (ADR 0020 supersedes ADR 0018).
  useAppendReveal({
    virtualizer,
    scrollerEl,
    notes,
    revealingRef,
    setRevealing,
    suppressThumbResizeRef,
  })
  // Prevent the virtualizer's own scroll-position correction from fighting the
  // manual bottom-anchor during an active morph OR make-room reveal. ADR 0007 /
  // ADR 0019. Both drive scrollTop themselves; an estimate→measured size
  // correction mid-animation would yank it.
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = () =>
    morphingIndexRef.current === null && !revealingRef.current
  // shouldAdjust above does NOT gate virtual-core's `anchorTo:'end'` "wasAtEnd"
  // path: in resizeItem the `if (wasAtEnd) applyScrollAdjustment(...)` branch is
  // unconditional (dist/esm/index.js). When collapsing a note near the bottom,
  // that branch rides the scroll up by the size delta AT THE SAME TIME as our
  // manual bottom-anchor — double-applying, so the viewport overshoots above all
  // content and the feed blanks for the morph. The make-room reveal hits the same
  // hazard the instant the new full-size row is FIRST measured (that one `wasAtEnd`
  // would ride the scroll up by ~noteH and never be cleared — the #66 white wall).
  // Drop anchorTo to 'start' for the morph AND the whole send (`sendInFlight`, which
  // is true from ghost-launch THROUGH the append, so it covers the new row's first
  // measure too — not just `revealing`, which is set only AFTER the append) so OUR
  // scroll is the only thing moving; restore 'end' after. (anchorTo is read live as
  // this.options.anchorTo.) ADR 0007 / 0019; see useAppendReveal for the #66 rationale.
  virtualizer.options.anchorTo =
    morphingIndexRef.current === null && !revealing && !sendInFlight ? 'end' : 'start'
  // Suppress the virtualizer's own `followOnAppend` auto-scroll while a send is in
  // flight: on the send's append, virtual-core's `_willUpdate` would `scrollToEnd()`
  // to the new note's ESTIMATE-inflated bottom (and arm its `reconcileScroll` rAF
  // loop) one frame before the make-room reveal's frame 0 collapses the row — a
  // visible pre-roll scroll blip. The reveal (`useAppendReveal`) drives the scroll
  // itself, so the virtualizer must not also chase the bottom here. `sendInFlight`
  // is false under reduced-motion (no ghost), so normal auto-follow is unaffected.
  // Re-applied every render (like anchorTo) so useVirtualizer's setOptions can't
  // reset it mid-send.
  virtualizer.options.followOnAppend = !sendInFlight

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
      // Don't re-pin during a morph or make-room reveal — they drive scrollTop
      // themselves, and `scrollToEnd()` here would arm virtual-core's
      // `reconcileScroll` rAF loop against them (sending clears the composer →
      // the feed grows → this fires mid-reveal, a one-frame scroll blip).
      if (morphingIndexRef.current !== null || revealingRef.current) return
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
      // keyed on morphingIndex) BEFORE any measurement, so they don't trigger the
      // virtualizer's own resize/scroll reactions. This re-render does NOT change
      // the morphing bubble's props, so its memoized `<Markdown>` is untouched.
      flushSync(() => setMorphingIndex(index))
      const startItemH = itemEl.getBoundingClientRect().height

      let endItemH: number
      let nonBodyH: number
      const cachedCollapsed = collapsedGeomRef.current.get(id)
      if (collapsing && cachedCollapsed) {
        // Collapse via geometry cached at expand time — NO content swap, so the
        // heavy full `<Markdown>` (already mounted) is not re-rendered. The full
        // content stays mounted for the roll-up; `onCommit` truncates at finish
        // and the final remeasure reconciles any staleness. See #50.
        endItemH = cachedCollapsed.itemH
        nonBodyH = cachedCollapsed.nonBodyH
      } else {
        // Expand (or a collapse with no cached geometry — note wasn't on screen
        // when expanded). On expand, capture the CURRENT (collapsed) geometry for
        // a future collapse before swapping; then commit the END content to
        // measure its true size + chrome.
        if (!collapsing) {
          collapsedGeomRef.current.set(id, {
            itemH: startItemH,
            nonBodyH: startItemH - bodyEl.getBoundingClientRect().height,
          })
        }
        flushSync(() =>
          setExpandedIds((prev) => (collapsing ? removeId(prev, id) : addId(prev, id))),
        )
        endItemH = itemEl.getBoundingClientRect().height
        nonBodyH = endItemH - bodyEl.getBoundingClientRect().height
        // Collapse fallback: restore FULL content so the roll-up animates over real text.
        if (collapsing) flushSync(() => setExpandedIds((prev) => addId(prev, id)))
      }

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
    // Forward to the optional external scrollerRef (send-animation geometry).
    // Handles both function- and object-ref forms; read via the stable holder
    // so this callback's identity stays frozen (ADR 0004).
    const ext = externalScrollerRef.current
    if (typeof ext === 'function') ext(el)
    else if (ext) ext.current = el
  }, [])

  const thumb = useScrollThumb(scrollerEl, suppressThumbResizeRef)

  // ── floating "scroll date" pill (Telegram-style) ───────────────────────────
  // On scroll: label = the topmost visible note's day; push = how far the next
  // day's inline divider has risen into the top zone (it shoves the old pill out
  // as it arrives, and the label flips to the new day exactly as the old pill
  // clears the top — so they never overlap); visible = true, fading 800ms after
  // scrolling stops. Reading geometry here never moves the list (no feedback loop):
  // it only updates the overlay. The pillKeyRef guard skips setState on frames
  // where neither the label nor the rounded push changed.
  const [scrollPill, setScrollPill] = useState<{ label: string; push: number } | null>(null)
  const [pillVisible, setPillVisible] = useState(false)
  const pillKeyRef = useRef('')
  const pillIdleRef = useRef<number | undefined>(undefined)
  const onFeedScroll = useCallback(() => {
    const el = scrollerEl
    if (!el) return
    const top = el.scrollTop
    const items = virtualizer.getVirtualItems()
    const firstVisible = items.find((it) => it.end > top + 1) ?? items[items.length - 1]
    const note = firstVisible ? notes[firstVisible.index] : undefined
    // Next day-boundary still below the top edge: as it rises within DAY_DIVIDER_H,
    // push the current (older-day) pill up by the overlap.
    let push = 0
    const incoming = items.find((it) => dayFirsts.has(it.index) && it.start > top)
    if (incoming && incoming.start - top < DAY_DIVIDER_H) {
      push = Math.round(DAY_DIVIDER_H - (incoming.start - top))
    }
    const label = note ? formatDayLabel(note.created_at) : ''
    const key = note ? `${label}|${push}` : ''
    if (key !== pillKeyRef.current) {
      pillKeyRef.current = key
      setScrollPill(note ? { label, push } : null)
    }
    setPillVisible(true)
    if (pillIdleRef.current !== undefined) clearTimeout(pillIdleRef.current)
    pillIdleRef.current = window.setTimeout(() => setPillVisible(false), 800)
  }, [scrollerEl, virtualizer, notes, dayFirsts])
  // Clear the idle timer on unmount so it can't setState an unmounted feed.
  useEffect(
    () => () => {
      if (pillIdleRef.current !== undefined) clearTimeout(pillIdleRef.current)
    },
    [],
  )

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
          onScroll={onFeedScroll}
          style={{
            height: '100%',
            overflowY: 'auto',
            overflowX: 'hidden',
            // Bottom-anchor (chat-style): with the content wrapper's
            // `margin-top:auto` below, a short feed sits flush at the bottom by
            // the composer (not top-aligned with a gap), so a new note pushes the
            // whole stack UP. When content overflows, the auto-margin collapses to
            // 0 and normal top-down scrolling resumes.
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          {/* Inner spacer: tanstack-virtual sets this element's height to
             the exact total content size (sum of measured sizes plus
             estimates for unmeasured items). The browser's `scrollHeight`
             on the outer scroller equals this inner height — that's what
             makes the custom scrollbar thumb stable. `marginTop:auto` bottom-
             anchors it; `flexShrink:0` keeps its exact getTotalSize height in the
             flex column; `contentRef` is the element useAppendReveal translates. */}
          <div
            ref={contentRef}
            style={{
              height: virtualizer.getTotalSize(),
              width: '100%',
              position: 'relative',
              marginTop: 'auto',
              flexShrink: 0,
            }}
          >
            {virtualizer.getVirtualItems().map((vItem) => {
              const note = notes[vItem.index]
              if (!note) return null
              return (
                <div
                  key={vItem.key}
                  // Detach measureElement only while this item is MORPHING — the morph
                  // drives the row's size via resizeItem, and tanstack forbids mixing
                  // measureElement + resizeItem on one item (ADR 0007). The make-room
                  // reveal no longer resizes the row (it glides the scroll, keeping the
                  // row full-size — useAppendReveal), so the revealing row stays measured.
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
                  {dayFirsts.has(vItem.index) && (
                    <DayDivider label={formatDayLabel(note.created_at)} />
                  )}
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
                    {...(onOpenThread ? { onOpenThread } : {})}
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
        {scrollPill && (
          <ScrollDatePill label={scrollPill.label} push={scrollPill.push} visible={pillVisible} />
        )}
      </div>
    </div>
  )
}
