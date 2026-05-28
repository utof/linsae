import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso'
import type { Note } from '../../../shared/types'
import { ScrollThumb, useScrollThumb } from '../components/ScrollArea'
import {
  clearMeasurement,
  getCachedHeight,
  getMeasurementTick,
  recordMeasurement,
  subscribeMeasurements,
} from './measurementCache'
import { NoteBubble } from './NoteBubble'

/**
 * Cold-cache height estimate for a not-yet-measured note. Used only as a
 * fallback inside `modelTotal` — replaced by the real ResizeObserver-
 * reported height the moment the bubble mounts and paints.
 *
 * The bubble caps its rendered body at NoteBubble's BODY_TRUNCATE_AT=4096
 * chars and surfaces an expand-button row past that. The heuristic mirrors:
 *   - 26 px wrapper padding (12) + bubble border (2) + bubble padding (12)
 *   - 22 px / wrapped line at our 14 px font + 560 px max-width (~70 chars)
 *   - +18 px for the expand-button row when overCap
 * Within ~10 px of real for typical short notes; converges via real
 * measurement on first viewport entry. Must stay loosely in sync with
 * NoteBubble's BODY_TRUNCATE_AT — repeated here as 4096 rather than
 * imported because exporting one UI constant for one consumer is more
 * API surface than the duplicate is worth.
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

interface MeasuredBubbleProps {
  note: Note
  focused: boolean
  onFocus: () => void
  onWikilinkClick: (slug: string) => void
  resolveSlug?: (slug: string) => boolean
  onEdit: () => void
  onDelete: () => void
  onCopyLink: () => void
}

/**
 * Wraps `NoteBubble` with (1) the inter-bubble vertical gap as wrapper
 * padding (so Virtuoso's internal size measurements account for it) and
 * (2) a ResizeObserver that reports the wrapper's painted border-box
 * height into the per-note measurement cache. Feed reads the cache (via
 * useSyncExternalStore) to derive a `modelTotal` it passes to
 * `useScrollThumb`, decoupling the custom thumb from Virtuoso's flaky
 * estimate-then-measure scrollHeight.
 *
 * Why a wrapper component (not a hook inside NoteBubble): NoteBubble's
 * own outer div is the styled white card whose height excludes the
 * inter-bubble gap. Observing this wrapper instead captures the gap and
 * yields the same number Virtuoso would compute for its size cache —
 * keeping the thumb math grounded in the same units as the scroller.
 *
 * Cache cleanup on note deletion lives in the parent Feed (which owns
 * the notes array); virtualization-driven unmount/remount does NOT clear
 * the cache so measurements survive scroll-out-of-viewport.
 */
function MeasuredBubble({
  note,
  focused,
  onFocus,
  onWikilinkClick,
  resolveSlug,
  onEdit,
  onDelete,
  onCopyLink,
}: MeasuredBubbleProps) {
  const wrapperRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const el = wrapperRef.current
    if (!el) return
    const ro = new ResizeObserver(([entry]) => {
      if (!entry) return
      // Prefer borderBoxSize (the modern, spec-compliant box that includes
      // padding+border, which is what painting + scrollHeight contribute
      // to). contentRect would exclude our 12px wrapper padding and the
      // bubble's own 12px+2px chrome — fall back to it only if the browser
      // doesn't ship borderBoxSize (older WebKit), adding +12 to compensate
      // for the wrapper padding (the bubble's own padding+border is inside
      // contentRect.height already).
      const h = entry.borderBoxSize?.[0]
        ? entry.borderBoxSize[0].blockSize
        : entry.contentRect.height + 12
      recordMeasurement(note.id, h)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [note.id])

  return (
    <div ref={wrapperRef} style={{ paddingTop: 6, paddingBottom: 6 }}>
      <NoteBubble
        note={note}
        focused={focused}
        onFocus={onFocus}
        onWikilinkClick={onWikilinkClick}
        {...(resolveSlug ? { resolveSlug } : {})}
        onEdit={onEdit}
        onDelete={onDelete}
        onCopyLink={onCopyLink}
      />
    </div>
  )
}

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

  // Subscribe to the per-note measurement cache populated by `MeasuredBubble`
  // below. `useSyncExternalStore`'s `getSnapshot` requires a stable scalar
  // — the cache itself mutates in place, so we expose a monotonic tick.
  // Every cache write bumps the tick → React re-derives `modelTotal`.
  const measurementTick = useSyncExternalStore(subscribeMeasurements, getMeasurementTick)

  // Total content height the thumb projects against, derived from the
  // measurement cache rather than `scrollEl.scrollHeight`. Why: OSS
  // react-virtuoso fundamentally swaps unmeasured-item placeholder
  // estimates for real heights as items enter viewport, which jerks
  // anything bound to scrollHeight (maintainer-confirmed at
  // petyosi/react-virtuoso#1240). The cache holds real measured heights
  // (no swap), and uncached notes fall back to a per-note text-length
  // heuristic — close enough that the cache→real handoff is invisible
  // under the 200 ms eased transition. Without the per-note heuristic
  // fallback the cold-cache modelTotal grossly mismatches Virtuoso's
  // scrollHeight, causing scrollTop / (modelTotal - clientHeight) to
  // exceed 1 and the thumb to land below the viewport on app start.
  //
  // biome-ignore lint/correctness/useExhaustiveDependencies: measurementTick is the subscription signal that gates cache validity
  const modelTotal = useMemo(() => {
    if (notes.length === 0) return 0
    let total = 0
    for (const n of notes) {
      total += getCachedHeight(n.id) ?? estimateBubbleHeight(n.body)
    }
    return total
  }, [notes, measurementTick])

  // Drop cache entries for notes removed from the data (note deletion).
  // Virtuoso virtualization unmount must NOT clear (we want measurements
  // to survive scroll-out-of-viewport) — that's why the cleanup lives here
  // in the parent owner of the notes array, not in `MeasuredBubble`.
  const prevIdsRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    const currentIds = new Set(notes.map((n) => n.id))
    for (const oldId of prevIdsRef.current) {
      if (!currentIds.has(oldId)) clearMeasurement(oldId)
    }
    prevIdsRef.current = currentIds
  }, [notes])

  // Custom thumb driver. Bound to modelTotal (the cache-derived sum)
  // instead of the DOM scrollHeight so the thumb's size/position only
  // changes on real per-note measurements, never on Virtuoso's internal
  // estimate→measure swap.
  const thumb = useScrollThumb(scrollerEl, modelTotal)

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

  // Memoize all `<Virtuoso>` callback/object props.
  //
  // Why: React 19 tightened ref-callback identity semantics — a
  // ref-callback prop whose identity differs from the previous render is
  // treated as detach (cleanup) + reattach (setup). Inline callbacks here
  // would change identity on every Feed re-render, which would re-run
  // Virtuoso's internal `co()` useEffect (dist/index.mjs:2380-2385)
  // cleanup + setup cycle. That cycle writes scroll state into Virtuoso's
  // internal stream, which fan-outs through Virtuoso's many
  // `useEmitterValue` (a `useSyncExternalStore` wrapper at
  // dist/index.mjs:2323) subscribers — each one calling
  // `forceStoreRerender` on a snapshot change. Combined with our own
  // measurement-cache subscription, that fan-out blew past React's ~50
  // nested-update depth limit and trip "Maximum update depth exceeded",
  // which `ErrorBoundary` then caught and the user saw as a blank-flash +
  // scroll-position teleport. Memoization stabilizes the identities so
  // Virtuoso's internal effects only re-run on real semantic changes.
  //
  // Closest documented analog of this React 19 footgun is
  // `radix-ui/primitives#3799`. @see ADR 0004.
  //
  // `initialTopMostItemIndex` is read only at mount, so we freeze it via
  // useMemo with empty deps (notes.length captured on first render). The
  // suppression below is intentional — re-evaluating would invalidate the
  // mount-time anchor.
  const handleScrollerRef = useCallback((el: HTMLElement | Window | null) => {
    const node = (el && 'classList' in el ? el : null) as HTMLElement | null
    scrollerRef.current = node
    setScrollerEl(node)
    // Hide Virtuoso's native scrollbar — the custom thumb owns visibility.
    // .scroll-area-inner in globals.css covers ::-webkit-scrollbar; inline
    // scrollbarWidth covers Firefox.
    if (node) {
      node.classList.add('scroll-area-inner')
      node.style.scrollbarWidth = 'none'
    }
  }, [])

  const computeItemKey = useCallback((_: number, note: Note) => note.id, [])

  // biome-ignore lint/correctness/useExhaustiveDependencies: Virtuoso reads this only at mount; freezing the initial anchor captures the correct "start at the last bubble" position
  const initialTopMostItemIndex = useMemo(
    () => ({ index: Math.max(0, notes.length - 1), align: 'end' as const }),
    [],
  )

  const itemContent = useCallback(
    (_: number, note: Note) => (
      <MeasuredBubble
        note={note}
        focused={note.id === focusedId}
        onFocus={() => onFocus(note.id)}
        onWikilinkClick={onWikilinkClick}
        {...(resolveSlug ? { resolveSlug } : {})}
        onEdit={() => onEdit(note.id)}
        onDelete={() => onDelete(note.id)}
        onCopyLink={() => onCopyLink(note.id)}
      />
    ),
    [focusedId, onFocus, onWikilinkClick, resolveSlug, onEdit, onDelete, onCopyLink],
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
        <Virtuoso
          ref={virtuoso}
          data={notes}
          computeItemKey={computeItemKey}
          initialTopMostItemIndex={initialTopMostItemIndex}
          alignToBottom
          // skipAnimationFrameInResizeObserver tightens Virtuoso's
          // measure→paint loop (TSDoc at
          // node_modules/.../react-virtuoso/dist/index.d.ts:1906-1909).
          // We briefly removed it in `823d506` on a wrong hypothesis that
          // it was driving a cascade; the real cascade trigger was inline
          // ref-callback identity churn (now fixed via the memoizations
          // above). Restoring the prop because (a) it reduces visible
          // flicker during fast scroll by avoiding the rAF delay between
          // item render and its measurement propagating, and (b) the
          // benign "ResizeObserver loop completed" warning it sometimes
          // produces is suppressed below.
          skipAnimationFrameInResizeObserver
          scrollerRef={handleScrollerRef}
          itemContent={itemContent}
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
