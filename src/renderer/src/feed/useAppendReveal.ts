import type { Virtualizer } from '@tanstack/react-virtual'
import { animate } from 'motion'
import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import type { Note } from '../../../shared/types'

/**
 * "Visual duration" (seconds) of the make-room reveal — how long the feed takes to
 * slide the new note up into place. Kept slightly SHORTER than the ghost flight
 * (`useSendAnimation`, ~0.46s) so the feed has settled by the time the ghost lands
 * and hands off. Dev slow-mo via `window.__morphSlow`.
 */
const REVEAL_VISUAL_DURATION = 0.4

/**
 * Makes a newly-sent note **push the whole feed up** as it arrives — the iMessage
 * "the conversation makes room" half of the send animation (the ghost flight is the
 * other half, see `useSendAnimation`).
 *
 * How (scroll-glide — NO per-frame `resizeItem`): the appended row mounts at its
 * FULL height (it's `opacity:0`, hidden by `Feed`, until the ghost lands, but it
 * occupies its real layout slot from frame 0, so the virtualizer measures it ONCE,
 * correctly). We then start the scroller one note-height short of the bottom (the
 * new row just below the fold) and animate `scrollTop` up to the true bottom, so the
 * whole feed glides up and the new note rises into view. The ghost dissolves onto it.
 *
 * Why NOT the old height-unroll (per-frame `virtualizer.resizeItem(index, h)`):
 * `resizeItem` has an UNCONDITIONAL `wasAtEnd` branch (when `anchorTo:'end'` + at
 * end) that accumulates an internal `scrollAdjustments` virtual-core only clears on a
 * REAL scroll event. Because the reveal drives `scrollTop` directly, it never cleared
 * — so under overlapping sends the virtualizer's range desynced and rendered the
 * WRONG row window (the #66 "white wall": blank band at top, "scrolling restores").
 * This version never calls `resizeItem`, so that accumulation cannot happen. The
 * caller additionally holds `anchorTo:'start'` for the whole send (`sendInFlight`, not
 * just `revealing`) so even the new row's first measure can't fire `wasAtEnd`.
 *
 * Direct `scrollTop` writes (never `virtualizer.scrollToEnd()`) keep us off
 * `reconcileScroll`'s self-correcting rAF loop, same as the expand/collapse morph.
 *
 * No-ops (the note just appears) for: reduced motion, a bulk/initial load (more than
 * one note added at once), the user scrolled away from the bottom, a zero-height row,
 * a missing scroller, or a short feed with no scroll room to glide (it's already
 * bottom-anchored, so the note is fully visible — nothing to push).
 *
 * @see adrs/0019-motion-animation-library.md
 * @see src/renderer/src/composer/useSendAnimation.tsx (the ghost-flight half)
 * @see local_files/2026-06-03-send-animation-handoff.md (#66 root cause + why scroll-glide)
 */
export function useAppendReveal(args: {
  // biome-ignore lint/suspicious/noExplicitAny: virtualizer is generic over the scroll element type; the hook only uses index-agnostic APIs.
  virtualizer: Virtualizer<any, any>
  scrollerEl: HTMLElement | null
  notes: Note[]
  /** Live flag the caller reads at render time to gate anchorTo / shouldAdjust. */
  revealingRef: { current: boolean }
  /** Re-renders the caller so the gated virtualizer options re-apply. */
  setRevealing: (v: boolean) => void
  /** Shared with the morph: pauses the scrollbar thumb while we drive the scroll. */
  suppressThumbResizeRef: { current: boolean }
}) {
  const { virtualizer, scrollerEl, notes, revealingRef, setRevealing, suppressThumbResizeRef } =
    args
  const controlsRef = useRef<{ stop: () => void } | null>(null)
  const failTimerRef = useRef<number | undefined>(undefined)
  // Previous list shape, to detect a single append. Initialised to the first
  // render's value so the initial mount (empty → loaded list) is never an append.
  const prevRef = useRef<{ count: number; lastId: string | undefined }>({
    count: notes.length,
    lastId: notes[notes.length - 1]?.id,
  })

  // Force the reveal to its END state: suppression released, pinned to the true
  // bottom. Driven by the animation's `onComplete` AND a fail-safe timer. Idempotent.
  const settle = useCallback(() => {
    if (failTimerRef.current !== undefined) {
      clearTimeout(failTimerRef.current)
      failTimerRef.current = undefined
    }
    controlsRef.current = null
    revealingRef.current = false
    setRevealing(false)
    suppressThumbResizeRef.current = false
    // Pin to the true bottom with a DIRECT write — NOT virtualizer.scrollToEnd(),
    // which arms reconcileScroll's self-correcting rAF loop.
    if (scrollerEl) scrollerEl.scrollTop = scrollerEl.scrollHeight
  }, [scrollerEl, revealingRef, setRevealing, suppressThumbResizeRef])

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
    if (!scroller) return

    const reduced =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    if (reduced) return

    // Real height of the appended row from its DOM node (layout effect → the node is
    // laid out; opacity:0 hiding does not affect layout, so the height is real).
    const node = scroller.querySelector<HTMLElement>(`[data-index="${count - 1}"]`)
    if (!node) return
    const noteH = node.getBoundingClientRect().height
    if (noteH <= 0) return

    // Only reveal when the user was pinned to the bottom (not browsing history). The
    // append already grew getTotalSize by ~noteH but the scroll hasn't followed, so
    // distance-from-end reads ≈ noteH; widen the threshold by noteH so the test
    // reflects the PRE-append distance (a tall note alone exceeds the bare 120 floor).
    if (!virtualizer.isAtEnd(noteH + virtualizer.options.scrollEndThreshold)) return

    stop() // cancel + settle any previous in-flight reveal

    // Scroll room to glide the new (full-size) row up into view. On a short,
    // non-overflowing feed there is none — the row is already fully visible via the
    // bottom-anchor — so skip the animation (the note simply appears).
    const endScroll = scroller.scrollHeight - scroller.clientHeight
    const startScroll = Math.max(0, endScroll - noteH)
    if (endScroll - startScroll < 1) return

    revealingRef.current = true
    setRevealing(true) // re-render → anchorTo:'start', size-correction suppressed
    suppressThumbResizeRef.current = true
    // Flip the live anchor to 'start' NOW (the `revealing` re-render re-applies it;
    // this covers the synchronous frame below). With `anchorTo:'start'` virtual-core's
    // unconditional `wasAtEnd` scroll jump never fires while we drive the scroll.
    virtualizer.options.anchorTo = 'start'

    // Start with the new full-size row just below the fold, then glide the feed up.
    scroller.scrollTop = startScroll

    const duration = import.meta.env.DEV
      ? REVEAL_VISUAL_DURATION * (window.__morphSlow ?? 1)
      : REVEAL_VISUAL_DURATION
    // `bounce: 0` — no overshoot past the true bottom (an overshoot would scroll into
    // blank space below the last note).
    controlsRef.current = animate(startScroll, endScroll, {
      type: 'spring',
      bounce: 0,
      visualDuration: duration,
      onUpdate: (v) => {
        scroller.scrollTop = v
      },
      onComplete: settle,
    })
    // Fail-safe: if `onComplete` never fires, force the end state. Scales with slow-mo.
    if (failTimerRef.current !== undefined) clearTimeout(failTimerRef.current)
    failTimerRef.current = window.setTimeout(settle, duration * 1000 + 800)
  }, [
    notes,
    scrollerEl,
    virtualizer,
    stop,
    settle,
    setRevealing,
    revealingRef,
    suppressThumbResizeRef,
  ])
}
