import type { Virtualizer } from '@tanstack/react-virtual'
import { animate } from 'motion'
import { type RefObject, useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import type { Note } from '../../../shared/types'

/**
 * "Visual duration" (seconds) of the make-room reveal — how long the feed takes
 * to open the new note's slot. Kept slightly SHORTER than the ghost flight
 * (`useSendAnimation`, ~0.46s) so the slot has settled by the time the ghost
 * lands and hands off. Dev slow-mo via `window.__morphSlow`.
 */
const REVEAL_VISUAL_DURATION = 0.4

/**
 * Makes a newly-sent note **push the whole feed up** as it stuffs itself into
 * place — the iMessage "the conversation makes room" half of the send animation
 * (the ghost flight is the other half, see `useSendAnimation`).
 *
 * How (height-unroll, mirroring the expand/collapse morph — ADR 0007): the new
 * row's REAL height is animated 0 → noteH by clipping the row node and driving
 * `virtualizer.resizeItem(index, h)` each frame, while `scroller.scrollTop` is
 * written DIRECTLY to keep the new row's bottom pinned to the viewport bottom.
 * The bottom-anchored feed (`Feed`'s `margin-top:auto` wrapper) then glides every
 * existing note up as the slot opens — on a short feed via flexbox, on a tall
 * feed via the scroll. The note is `opacity:0` (hidden by `Feed`) until the ghost
 * lands, so visually the slot just opens and the ghost dissolves onto it.
 *
 * Why NOT a content-wrapper `transform` (the previous implementation): a
 * `translateY`-down on the content INFLATES the scroller's `scrollHeight` (CSS
 * Overflow L3 §scrollable — transformed descendant boxes count as scrollable
 * overflow), and `virtualizer.scrollToEnd()` arms `reconcileScroll`'s rAF loop
 * which then chases `scrollTop` to that inflated bottom every frame, cancelling
 * the mask 1:1 → the note teleported instead of gliding. Driving the real item
 * height + writing `scrollTop` directly (never `scrollToEnd`) is the one path that
 * does NOT inflate `scrollHeight` and NEVER arms the reconcile loop — exactly why
 * the morph works cleanly. This realigns the code with ADR 0019's own guardrail
 * ("append make-room reveal … animates `scrollTop` / clip height imperatively").
 *
 * During the reveal the caller flips the virtualizer to `anchorTo:'start'`,
 * suppresses its size-change scroll correction (the `revealing` flag, shared with
 * the morph), and detaches `measureElement` from the revealing row so its
 * ResizeObserver can't fight our per-frame `resizeItem`. `settle` releases all of
 * that and pins to the true bottom.
 *
 * No-ops (the note just appears) for: reduced motion, a bulk/initial load (more
 * than one note added at once), the user being scrolled away from the bottom, a
 * zero-height row, or a missing scroller/content.
 *
 * @see adrs/0019-motion-animation-library.md
 * @see adrs/0007-animate-virtual-item-resize.md (the resizeItem+scrollTop lockstep this mirrors)
 * @see src/renderer/src/composer/useSendAnimation.tsx (the ghost-flight half)
 */
export function useAppendReveal(args: {
  // biome-ignore lint/suspicious/noExplicitAny: virtualizer is generic over the scroll element type; the hook only uses index-agnostic APIs.
  virtualizer: Virtualizer<any, any>
  scrollerEl: HTMLElement | null
  /** The content wrapper (height = getTotalSize); we keep its CSS height in sync per frame. */
  contentRef: RefObject<HTMLElement | null>
  notes: Note[]
  /** Live flag the caller reads at render time to gate anchorTo/shouldAdjust/measureElement. */
  revealingRef: { current: boolean }
  /** Re-renders the caller so the gated virtualizer options + ref detach re-apply. */
  setRevealing: (v: boolean) => void
  /** Shared with the morph: pauses the scrollbar thumb while we drive layout. */
  suppressThumbResizeRef: { current: boolean }
}) {
  const {
    virtualizer,
    scrollerEl,
    contentRef,
    notes,
    revealingRef,
    setRevealing,
    suppressThumbResizeRef,
  } = args
  const controlsRef = useRef<{ stop: () => void } | null>(null)
  const failTimerRef = useRef<number | undefined>(undefined)
  // The in-flight reveal's row node + its final size, so `settle` can finalize
  // (un-clip the row, commit the real size) even when fired by the fail-safe.
  const ctxRef = useRef<{ node: HTMLElement; index: number; noteH: number } | null>(null)
  // Previous list shape, to detect a single append. Initialised to the first
  // render's value so the initial mount (empty → loaded list) is never an append.
  const prevRef = useRef<{ count: number; lastId: string | undefined }>({
    count: notes.length,
    lastId: notes[notes.length - 1]?.id,
  })

  // Force the reveal to its END state: row un-clipped at its real size, content
  // height handed back to React, suppression released, pinned to the true bottom.
  // Driven by the animation's `onComplete` AND a fail-safe timer, so a freshly-sent
  // note can NEVER be left clipped below the fold if completion never fires. Idempotent.
  const settle = useCallback(() => {
    if (failTimerRef.current !== undefined) {
      clearTimeout(failTimerRef.current)
      failTimerRef.current = undefined
    }
    controlsRef.current = null
    const ctx = ctxRef.current
    if (ctx) {
      ctx.node.style.removeProperty('height')
      ctx.node.style.removeProperty('overflow')
      ctx.node.style.removeProperty('box-sizing')
      virtualizer.resizeItem(ctx.index, ctx.noteH)
      ctxRef.current = null
    }
    const content = contentRef.current
    if (content) content.style.removeProperty('height') // hand height back to React (getTotalSize)
    revealingRef.current = false
    setRevealing(false)
    suppressThumbResizeRef.current = false
    // Pin to the true bottom with a DIRECT write — NOT virtualizer.scrollToEnd(),
    // which arms reconcileScroll's self-correcting rAF loop (vc reconcileScroll).
    if (scrollerEl) scrollerEl.scrollTop = scrollerEl.scrollHeight
  }, [contentRef, scrollerEl, revealingRef, setRevealing, suppressThumbResizeRef, virtualizer])

  const stop = useCallback(() => {
    controlsRef.current?.stop()
    settle()
  }, [settle])

  // Stop any in-flight reveal on unmount.
  useEffect(() => stop, [stop])

  useLayoutEffect(() => {
    const prev = prevRef.current
    const count = notes.length
    const lastId = notes[count - 1]?.id
    prevRef.current = { count, lastId }

    // Single append at the end, by a genuine new id, on a non-empty prior list.
    const appended = count === prev.count + 1 && lastId !== prev.lastId && prev.count > 0
    if (!appended) return
    const scroller = scrollerEl
    const content = contentRef.current
    if (!scroller || !content) return

    const reduced =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    if (reduced) return

    // Real height of the appended row from its DOM node (layout effect → the node
    // is laid out; opacity:0 hiding does not affect layout, so the height is real).
    const node = scroller.querySelector<HTMLElement>(`[data-index="${count - 1}"]`)
    if (!node) return
    const noteH = node.getBoundingClientRect().height
    if (noteH <= 0) return

    // Only reveal when the user was pinned to the bottom (not browsing history).
    // We check AFTER the append, when getTotalSize has already grown by ~noteH but
    // the virtualizer's scroll hasn't necessarily followed yet — so the raw
    // distance-from-end reads ≈ noteH for an at-bottom user, and a bare `isAtEnd()`
    // (threshold 120) spuriously bails for a TALL note (its height alone exceeds
    // 120 → the reveal no-ops and the note pops in). Widen the threshold by noteH so
    // the test reflects the PRE-append distance: within scrollEndThreshold before?
    if (!virtualizer.isAtEnd(noteH + virtualizer.options.scrollEndThreshold)) return

    stop() // cancel + settle any previous in-flight reveal
    revealingRef.current = true
    setRevealing(true) // re-render → anchorTo:'start', size-correction + measureElement detached
    suppressThumbResizeRef.current = true
    // Flip the live anchor to 'start' NOW so the synchronous frame-0 resizeItem below
    // can't fire virtual-core's unconditional `anchorTo:'end'` wasAtEnd scroll jump
    // (the `revealing` re-render re-applies it; this covers the pre-render frame 0).
    virtualizer.options.anchorTo = 'start'

    const index = count - 1
    ctxRef.current = { node, index, noteH }

    // One frame of the unroll: clip the row to height `h` (border-box, so it matches
    // the measured value resizeItem expects), tell the virtualizer the row is `h`
    // tall, sync the content wrapper's CSS height to the new getTotalSize, then pin
    // the bottom with a DIRECT scrollTop write. No transform → no scrollHeight
    // inflation; direct scrollTop → never arms reconcileScroll.
    const applyFrame = (h: number) => {
      const clamped = Math.max(0, Math.min(noteH, h))
      node.style.boxSizing = 'border-box'
      node.style.overflow = 'hidden'
      node.style.height = `${clamped}px`
      virtualizer.resizeItem(index, clamped)
      content.style.height = `${virtualizer.getTotalSize()}px`
      scroller.scrollTop = scroller.scrollHeight
    }
    // Frame 0 = the collapsed slot (h=0), applied SYNCHRONOUSLY before paint so the
    // note never flashes at full height and nothing jumps: the feed looks exactly
    // like the pre-send state, then the slot opens.
    applyFrame(0)

    const duration = import.meta.env.DEV
      ? REVEAL_VISUAL_DURATION * (window.__morphSlow ?? 1)
      : REVEAL_VISUAL_DURATION
    // `bounce: 0` — a spring with NO overshoot: an overshoot (h > noteH) would clip
    // the row past its content (an empty gap), so the unroll must be monotonic.
    controlsRef.current = animate(0, noteH, {
      type: 'spring',
      bounce: 0,
      visualDuration: duration,
      onUpdate: applyFrame,
      onComplete: settle,
    })
    // Fail-safe: if `onComplete` never fires, force the end state so the note is
    // never left clipped. Scales with the dev slow-mo so it doesn't cut short.
    if (failTimerRef.current !== undefined) clearTimeout(failTimerRef.current)
    failTimerRef.current = window.setTimeout(settle, duration * 1000 + 800)
  }, [
    notes,
    scrollerEl,
    contentRef,
    virtualizer,
    stop,
    settle,
    setRevealing,
    revealingRef,
    suppressThumbResizeRef,
  ])
}
