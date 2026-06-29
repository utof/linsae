import { useVirtualizer } from '@tanstack/react-virtual'
import { Check, CheckCircle2, Copy, ListChecks, Trash2, XCircle } from 'lucide-react'
import { type Ref, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import type { Note } from '../../../shared/types'
import { ScrollThumb, useScrollThumb } from '../components/ScrollArea'
import { dayKey, formatDayLabel } from '../lib/day'
import { type ContextMenuItem, type ContextMenuPos, ContextMenuShell } from './ContextMenu'
import { DayDivider, ScrollDatePill } from './DatePills'
import { useEntranceAnimation } from './entrance/useEntranceAnimation'
import { FEED_BAND, type FeedBand } from './feedBand'
import { NoteBubble } from './NoteBubble'
import { SelectionBar } from './SelectionBar'
import { fillToIndex } from './selectionRange'
import { useDragSelect } from './useDragSelect'
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
   * Ids of notes that currently have a placed card on the canvas (§9). Drives
   * each bubble's ▦ trace. Defaults to an empty set so callers that don't track
   * canvas placement render unchanged. App provides the real set (Task 10).
   */
  placedNoteIds?: ReadonlySet<string>
  /** Add a note to the shelf, stay in the feed (§4). Threaded to NoteBubble by id. */
  onShelf?: (id: string) => void
  /** One-shot placement that switches to the canvas (§6). Threaded to NoteBubble by id. */
  onPlaceOnCanvas?: (id: string) => void
  /** Jump to a note's existing card on the canvas (§9). Threaded to NoteBubble by id. */
  onJumpToCard?: (id: string) => void
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
   * make-room scroll-glide (`useGlideReveal`) owns the scroll while the note rises
   * in — without it, the new row's first measure rides the scroll up and rapid sends
   * desync the rendered range (the #66 white wall). No ghost (ADR 0020).
   */
  sendInFlight?: boolean
  /**
   * "Model A" feed band (ADR 0047): when a dock is open, App measures the window
   * and the open dock widths and passes the resolved `{ maxWidth, marginLeft,
   * marginRight }` so the feed stays centered in the WINDOW (docks fill the side
   * gutters) and shrinks only once a dock is widened past its gutter. `null`/
   * undefined ⇒ the default centered `FEED_BAND.default` band with auto margins
   * (the pre-dock layout, unchanged). @see src/renderer/src/feed/feedBand.ts
   */
  band?: FeedBand | null
}

/** Stable empty set so the default `placedNoteIds` keeps a frozen identity
 * across renders (no new `Set` per render → no needless reconcile). */
const EMPTY_PLACED: ReadonlySet<string> = new Set()

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
 * True when a keyboard event originates inside an editable field, so the Feed's
 * global key shortcuts must yield. Why: an arrow/`x` while composing must reach
 * the textarea, never move feed focus (mirrors src/renderer/src/thread/ThreadView.tsx:349's reason for
 * omitting `enableOnFormTags`).
 */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  const el = target as HTMLElement
  return el.closest('textarea, input, [contenteditable="true"]') != null
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
  if (note.source_kind === 'youtube' && note.source_locator?.media === 'youtube') {
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
  placedNoteIds = EMPTY_PLACED,
  onShelf,
  onPlaceOnCanvas,
  onJumpToCard,
  scrollerRef,
  sendInFlight = false,
  band = null,
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

  // ── multi-select (Telegram-style) ──────────────────────────────────────────
  // Selected note ids; selection MODE is derived (size > 0) — deselecting the
  // last note exits the mode, exactly like Telegram. Ephemeral by design: dies
  // with the Feed (ThreadView swap), like expandedIds.
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(() => new Set())
  const selectionMode = selectedIds.size > 0
  // Live mirror for useDragSelect: the drag-start closure must read the
  // CURRENT selection as its rubber-band base without re-binding the
  // pointerdown handler on every selection change.
  const selectedIdsRef = useRef<ReadonlySet<string>>(selectedIds)
  selectedIdsRef.current = selectedIds

  // Prune ids whose notes vanished underneath the selection (external delete,
  // reconciler refetch) so the bar's counts can't drift from reality.
  useEffect(() => {
    setSelectedIds((prev) => {
      if (prev.size === 0) return prev
      const alive = new Set(notes.map((n) => n.id))
      const next = new Set([...prev].filter((id) => alive.has(id)))
      return next.size === prev.size ? prev : next
    })
  }, [notes])

  // Esc exits selection mode. Document-level listener (the ContextMenu
  // pattern) rather than App's useHotkeys ladder: selection is Feed-local
  // state, and threading it up to App's Esc handler would couple App to a
  // transient mode it otherwise never sees.
  useEffect(() => {
    if (!selectionMode) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setSelectedIds(new Set())
        setSelMenu(null)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [selectionMode])

  // Stable id-taking toggle (same shape as handleToggleExpand's set ops).
  const toggleSelected = useCallback((id: string) => {
    setSelectedIds((prev) => toggleSet(prev, id))
  }, [])

  // Copy = the "forward" analog: selected bodies in feed order, video cards
  // contribute their watch URL (their body is empty by construction).
  const copySelected = useCallback(() => {
    const chunks = notes
      .filter((n) => selectedIds.has(n.id))
      .map((n) =>
        n.type === 'source' && n.source_locator?.media === 'youtube'
          ? `https://youtu.be/${n.source_locator.video_id}`
          : n.body,
      )
    void navigator.clipboard?.writeText(chunks.join('\n\n'))
    setSelectedIds(new Set())
  }, [notes, selectedIds])

  const deleteSelected = useCallback(() => {
    for (const n of notes) {
      if (selectedIds.has(n.id)) onDelete(n.id)
    }
    setSelectedIds(new Set())
  }, [notes, selectedIds, onDelete])

  // Right-click selection menu: which note row it targets + viewport coords.
  const [selMenu, setSelMenu] = useState<{ pos: ContextMenuPos; noteId: string } | null>(null)

  // Telegram's "Select up to this message": bridge from the nearest selected
  // row to the target, inclusive (see fillToIndex's rationale).
  const selectUpTo = useCallback(
    (noteId: string) => {
      const target = notes.findIndex((n) => n.id === noteId)
      if (target === -1) return
      const selectedIndices = notes.flatMap((n, i) => (selectedIds.has(n.id) ? [i] : []))
      const next = new Set(selectedIds)
      for (const i of fillToIndex(selectedIndices, target)) {
        const n = notes[i]
        if (n) next.add(n.id)
      }
      setSelectedIds(next)
    },
    [notes, selectedIds],
  )

  // Items depend on what was right-clicked: a selected row gets the bulk
  // actions; an unselected row gets the two grow-the-selection verbs (only
  // "Select" when the mode isn't active yet — matches Telegram).
  const selectionMenuItems = (noteId: string): ContextMenuItem[] => {
    if (selectedIds.has(noteId)) {
      return [
        {
          key: 'copy',
          label: 'Copy selected as text',
          icon: <Copy size={14} />,
          onClick: copySelected,
          mnemonic: 'c',
        },
        {
          key: 'delete',
          label: 'Delete selected',
          icon: <Trash2 size={14} />,
          onClick: deleteSelected,
          danger: true,
          mnemonic: 'd',
        },
        {
          key: 'clear',
          label: 'Clear selection',
          icon: <XCircle size={14} />,
          onClick: () => setSelectedIds(new Set()),
          mnemonic: 'l',
        },
      ]
    }
    const items: ContextMenuItem[] = [
      {
        key: 'select',
        label: 'Select',
        icon: <CheckCircle2 size={14} />,
        onClick: () => setSelectedIds(addId(selectedIds, noteId)),
        mnemonic: 's',
      },
    ]
    if (selectionMode) {
      items.push({
        key: 'up-to',
        label: 'Select up to this note',
        icon: <ListChecks size={14} />,
        onClick: () => selectUpTo(noteId),
        mnemonic: 'u',
      })
    }
    return items
  }

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

  const [morphingIndex, setMorphingIndex] = useState<number | null>(null)
  const morphingIndexRef = useRef<number | null>(null)
  morphingIndexRef.current = morphingIndex
  const suppressThumbResizeRef = useRef<boolean>(false)
  // `revealing` is true while the make-room reveal (useGlideReveal) slides a
  // freshly-sent note up into place by translating the content wrapper. Like
  // `morphingIndex` it gates the virtualizer's scroll-correction below (so a
  // measure correction can't jump scrollTop out from under the transform); the
  // ref is read live in the `shouldAdjust` closure, the state forces the
  // anchorTo re-apply.
  const [revealing, setRevealing] = useState(false)
  const revealingRef = useRef(false)
  // `waveSettling` extends follow-suppression past the append, through the wave
  // engine's spring window (Task 9 sets it; inert in Batch 1 — glide never sets it).
  const [waveSettling, setWaveSettling] = useState(false)
  // The single follow-suppression signal: the submit→append bridge (`sendInFlight`),
  // glide's own scroll-settle (`revealing` STATE so the render-time options recompute
  // when it flips), and the wave's spring window (`waveSettling`). Fed INTO useVirtualizer
  // (anchorTo/followOnAppend) so it is correct at `setOptions` on the append render — the
  // spike's load-bearing finding (a post-hook `virtualizer.options.*` mutation does NOT
  // feed back into the next setOptions). @see docs/specs/v0.2.2-repulsion-wave.md §Guard.
  const suppressFollow = sendInFlight || revealing || waveSettling

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
    // anchorTo/followOnAppend gated on the morph AND the unified send/wave/glide
    // suppression, passed INTO the hook so they are correct at setOptions on the
    // append render. virtual-core gates its ENTIRE append-follow + scroll-anchor
    // block on `merged.anchorTo === 'end'` inside setOptions, and `_willUpdate`
    // (which fires scrollToEnd → arms the reconcileScroll rAF loop that re-pins the
    // newcomer to the bottom and cancels the --wy rise) runs in useVirtualizer's OWN
    // earlier layout effect — so a post-hook `virtualizer.options.anchorTo = 'start'`
    // is too late (resolvedOptions is rebuilt {...options} fresh each render and
    // re-fed to setOptions in the render body). Glide survived the post-hook form only
    // because it drives scrollTop itself and cooperates with the follow; the wave does
    // not. @see docs/specs/v0.2.2-repulsion-wave.md §Guard.
    //
    // Drop anchorTo to 'start' for the morph AND the whole send so OUR scroll is the
    // only thing moving; restore 'end' after. Why the morph needs it: virtual-core's
    // `wasAtEnd` branch in resizeItem is unconditional, so collapsing a note near the
    // bottom rides the scroll up by the size delta AT THE SAME TIME as our manual
    // bottom-anchor — double-applying, so the viewport overshoots above all content and
    // the feed blanks. The make-room reveal hits the same `wasAtEnd` hazard the instant
    // the new full-size row is FIRST measured (that one `wasAtEnd` would ride the scroll
    // up by ~noteH and never be cleared — the #66 white wall). ADR 0007 / 0019; see
    // useGlideReveal for the #66 rationale.
    anchorTo: morphingIndexRef.current === null && !suppressFollow ? 'end' : 'start',
    followOnAppend: !suppressFollow,
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
  // Reached through the entrance dispatcher (glide-only in Batch 1; Task 9 routes
  // flip/pbd to the wave engine). The dispatcher only forwards setters — the Feed
  // owns the suppression state and computes `suppressFollow` above useVirtualizer.
  useEntranceAnimation({
    virtualizer,
    scrollerEl,
    notes,
    revealingRef,
    setRevealing,
    suppressThumbResizeRef,
    setWaveSettling,
    sendInFlight,
  })
  const { onGutterPointerDown } = useDragSelect({
    scrollerEl,
    contentRef,
    virtualizer,
    notes,
    selectedIdsRef,
    setSelectedIds,
  })

  // ── keyboard focus navigation + selection (always mounted) ──────────────────
  // ArrowDown/ArrowUp move note focus; Shift+Arrow extends the selection
  // text-editor-style (focused note + destination both join selectedIds);
  // `x` toggles the focused note. Escape is deliberately NOT handled here —
  // the selection-Esc listener above and App's hotkey ladder own it.
  //
  // Why a document listener (not react-hotkeys-hook): matches the selection-Esc
  // precedent directly above and keeps this transient navigation Feed-local
  // (App never sees it). Guarded against modifiers (other than the explicit
  // Shift extension) and typing targets so it never steals composer keystrokes
  // — same rationale as src/renderer/src/thread/ThreadView.tsx:349.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (isTypingTarget(e.target)) return
      if (notes.length === 0) return
      const cur = focusedId === null ? -1 : notes.findIndex((n) => n.id === focusedId)

      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const down = e.key === 'ArrowDown'
        // Nothing focused: ArrowUp grabs the LAST row (nearest the composer),
        // ArrowDown the first. Otherwise step one and clamp at the ends.
        const next =
          cur === -1
            ? down
              ? 0
              : notes.length - 1
            : Math.max(0, Math.min(notes.length - 1, cur + (down ? 1 : -1)))
        e.preventDefault()
        // Clamped onto itself with nothing to extend → nothing to do.
        if (next === cur && !e.shiftKey) return
        if (e.shiftKey && cur !== -1) {
          // Extend: add BOTH ends of the step to the selection (entry into
          // selection mode from the keyboard), then move focus.
          const a = notes[cur]
          const b = notes[next]
          setSelectedIds((prev) => {
            const out = new Set(prev)
            if (a) out.add(a.id)
            if (b) out.add(b.id)
            return out
          })
        }
        // Only move focus on a REAL step: at a clamped boundary (next === cur,
        // Shift held) the extension above already selected the focused note, and
        // re-focusing the same id would TOGGLE it off via App's
        // `cur === id ? null : id` handler — closing the BacklinksPane.
        if (next !== cur) {
          const dest = notes[next]
          if (dest) {
            onFocus(dest.id)
            // Imperative scroll gated like every other one in this file (the
            // anchorTo gating + ResizeObserver re-pin): scrollToIndex arms
            // virtual-core's scroll-reconcile loop, which must stay dormant
            // during a morph or entrance animation (ADR 0007 / 0019).
            if (morphingIndexRef.current === null && !suppressFollow) {
              virtualizer.scrollToIndex(next, { align: 'auto' })
            }
          }
        }
        return
      }

      if (e.key === 'x') {
        if (cur === -1) return // nothing focused → no-op
        const n = notes[cur]
        if (n) {
          e.preventDefault()
          toggleSelected(n.id)
        }
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [notes, focusedId, onFocus, virtualizer, toggleSelected, suppressFollow])

  // Prevent the virtualizer's own scroll-position correction from fighting the
  // manual bottom-anchor during an active morph OR make-room reveal. ADR 0007 /
  // ADR 0019. Both drive scrollTop themselves; an estimate→measured size
  // correction mid-animation would yank it. Read live at resizeItem time, so it
  // stays a render-body instance assignment; folds the unified `suppressFollow`
  // (send + glide-revealing + wave-settling) in so a measure correction can't ride
  // the scroll for ANY entrance. The anchorTo/followOnAppend gating now lives in the
  // useVirtualizer options above (the spike's §Guard finding — a post-hook
  // `virtualizer.options.*` mutation is too late for the append render).
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = () =>
    morphingIndexRef.current === null && !suppressFollow

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
      // Model A (ADR 0047): when a dock is open App passes `band`, and the feed
      // surrenders its symmetric 32px padding to the computed gutters so the band
      // can sit centered-in-window (or flush against a wide dock). No dock ⇒ the
      // original `0 32px` padding + centered 720 band.
      style={{ flex: 1, minHeight: 0, padding: band ? 0 : '0 32px' }}
    >
      <div
        // No CSS `min-width` here on purpose (B14): the dock's render width is
        // window-capped (App + maxDockWidth) so `<main>` keeps ≥ FEED_BAND.min in
        // normal cases; letting the band shrink to fit its container guarantees the
        // feed can NEVER overflow under the dock, even in a pathologically narrow
        // window. @see adrs/0047-feed-default-width-docks-fill-gutters.md
        style={
          band
            ? {
                maxWidth: band.maxWidth,
                marginLeft: band.marginLeft,
                marginRight: band.marginRight,
                height: '100%',
                position: 'relative',
              }
            : {
                maxWidth: FEED_BAND.default,
                margin: '0 auto',
                height: '100%',
                position: 'relative',
              }
        }
      >
        <div
          ref={handleScrollerRef}
          onScroll={onFeedScroll}
          onPointerDown={onGutterPointerDown}
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
             flex column; `contentRef` is the element useGlideReveal translates. */}
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
                // biome-ignore lint/a11y/noStaticElementInteractions: the row wrapper is a virtualizer measurement container; the actionable targets are NoteBubble, the check-circle button, and the SelectionBar — the capture-phase click and context-menu handlers here implement the modal selection layer, not primary interactivity.
                <div
                  key={vItem.key}
                  // Detach measureElement only while this item is MORPHING — the morph
                  // drives the row's size via resizeItem, and tanstack forbids mixing
                  // measureElement + resizeItem on one item (ADR 0007). The make-room
                  // reveal no longer resizes the row (it glides the scroll, keeping the
                  // row full-size — useGlideReveal), so the revealing row stays measured.
                  ref={vItem.index === morphingIndex ? undefined : virtualizer.measureElement}
                  data-index={vItem.index}
                  // Selection mode is MODAL (Telegram): clicks anywhere on a row toggle
                  // membership instead of focusing/acting. Capture phase so the toggle
                  // wins over NoteBubble's onClick (focus) and the hover-bar buttons
                  // without threading a mode prop through every click handler.
                  onClickCapture={
                    selectionMode
                      ? (e) => {
                          e.preventDefault()
                          e.stopPropagation()
                          toggleSelected(note.id)
                        }
                      : undefined
                  }
                  // Selection mode is MODAL for right-click too: CAPTURE phase intercepts
                  // before NoteBubble's / MediaFeedNote's own onContextMenu can open the
                  // per-note menu, so the selection menu is the only menu while selecting.
                  onContextMenuCapture={
                    selectionMode
                      ? (e) => {
                          e.preventDefault()
                          e.stopPropagation()
                          setSelMenu({ pos: { x: e.clientX, y: e.clientY }, noteId: note.id })
                        }
                      : undefined
                  }
                  // Outside selection mode, only the free gutter opens the Select menu —
                  // presses on the bubble/card keep their own Edit/Copy-link/Delete menu.
                  onContextMenu={
                    !selectionMode
                      ? (e) => {
                          if ((e.target as HTMLElement).closest('[data-bubble]')) return
                          e.preventDefault()
                          setSelMenu({ pos: { x: e.clientX, y: e.clientY }, noteId: note.id })
                        }
                      : undefined
                  }
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    transform: `translateY(calc(${vItem.start}px + var(--wy, 0px)))`,
                    // Inter-bubble vertical gap as wrapper padding (not
                    // margin) so tanstack's `measureElement` reads a
                    // border-box height that already includes the gap.
                    // Same rationale as `6564a3d` carried forward.
                    paddingTop: 6,
                    paddingBottom: 6,
                    // Full-row tint marks selected rows (Telegram-style); accent at 8%
                    // keeps bubble borders readable on top of it.
                    background: selectedIds.has(note.id)
                      ? 'rgba(13, 153, 255, 0.08)'
                      : 'transparent',
                    borderRadius: 10,
                    transition: 'background 120ms ease',
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
                    selecting={selectionMode}
                    // Canvas ▦ traces — stable id-callbacks bound in NoteBubble's
                    // body (ADR 0006). `placed` flips the bubble's affordance set.
                    placed={placedNoteIds.has(note.id)}
                    {...(onShelf ? { onShelf } : {})}
                    {...(onPlaceOnCanvas ? { onPlaceOnCanvas } : {})}
                    {...(onJumpToCard ? { onJumpToCard } : {})}
                  />
                  {selectionMode && (
                    <button
                      type="button"
                      aria-label={selectedIds.has(note.id) ? 'deselect note' : 'select note'}
                      // No onClick: the wrapper's capture-phase handler above performs the
                      // toggle for every in-row click, including this button. The button
                      // exists as the visible affordance + semantic target.
                      style={{
                        position: 'absolute',
                        right: 8,
                        top: '50%',
                        transform: 'translateY(-50%)',
                        width: 22,
                        height: 22,
                        borderRadius: '50%',
                        border: selectedIds.has(note.id) ? 0 : '2px solid var(--border-1)',
                        background: selectedIds.has(note.id) ? '#0D99FF' : 'transparent',
                        color: '#fff',
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        padding: 0,
                        cursor: 'pointer',
                      }}
                    >
                      {selectedIds.has(note.id) && <Check size={14} strokeWidth={3} />}
                    </button>
                  )}
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
        {selectionMode && (
          <SelectionBar
            count={selectedIds.size}
            onCopy={copySelected}
            onDelete={deleteSelected}
            onCancel={() => setSelectedIds(new Set())}
          />
        )}
        {selMenu && (
          <ContextMenuShell
            pos={selMenu.pos}
            items={selectionMenuItems(selMenu.noteId)}
            onClose={() => setSelMenu(null)}
          />
        )}
        {scrollPill && (
          <ScrollDatePill label={scrollPill.label} push={scrollPill.push} visible={pillVisible} />
        )}
      </div>
    </div>
  )
}
