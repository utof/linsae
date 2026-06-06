import type { Virtualizer } from '@tanstack/react-virtual'
import { animate } from 'motion'
import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import type { Note } from '../../../shared/types'

type Cubic = [number, number, number, number]
type Tween = { duration: number; ease: Cubic }

// Three reveal tweens (duration + cubic-bezier easing) hand-tuned in the dev playground
// (mod+shift+R, `RevealPlayground`), anchored by the note's height-to-viewport ratio:
// SHORT at ~0 of a screen, BIG at half a screen, HUGE at a full screen (and beyond).
const SHORT: Tween = { duration: 0.5, ease: [0.4, 0.04, 0, 1] }
const BIG: Tween = { duration: 1.1, ease: [0.8, 0.07, 0, 0.97] }
const HUGE: Tween = { duration: 1.1, ease: [0.95, 0.5, 0, 0.97] }

const mix = (a: number, b: number, t: number) => a + (b - a) * t
const mixTween = (a: Tween, b: Tween, t: number): Tween => ({
  duration: mix(a.duration, b.duration, t),
  ease: [
    mix(a.ease[0], b.ease[0], t),
    mix(a.ease[1], b.ease[1], t),
    mix(a.ease[2], b.ease[2], t),
    mix(a.ease[3], b.ease[3], t),
  ],
})

/**
 * Reveal tween for a note `noteH` px tall in a `viewportH` px viewport. NOT bucketed:
 * the duration and every bezier control point are a CONTINUOUS blend of the three tuned
 * anchors by the height ratio (r) — so a note half a screen tall gets exactly BIG, a
 * quarter-screen note gets halfway from SHORT to BIG, etc. r is clamped to [0, 1].
 */
function revealTween(noteH: number, viewportH: number): Tween {
  const r = Math.min(1, Math.max(0, noteH / Math.max(1, viewportH)))
  return r <= 0.5 ? mixTween(SHORT, BIG, r / 0.5) : mixTween(BIG, HUGE, (r - 0.5) / 0.5)
}

/**
 * Makes a newly-sent note **push the whole feed up** as it arrives — the iMessage
 * "the conversation makes room" entrance. This IS the send animation: the note rises
 * into view via the scroll-glide; there is no flying ghost (ADR 0020 supersedes the
 * send-ghost ADR 0018).
 *
 * How (scroll-glide — NO per-frame `resizeItem`): the appended row mounts at its FULL
 * height, so the virtualizer measures it ONCE, correctly. We then start the scroller
 * one note-height short of the bottom (the new row just below the fold) and animate
 * `scrollTop` up to the true bottom, so the whole feed glides up and the new note
 * rises into view. A bigger note glides a longer distance in the fixed duration — it
 * scrolls faster, matching "bigger note ⇒ stronger push".
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
 * @see adrs/0020-remove-send-ghost.md (why the flying clone was removed)
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
    // append grew getTotalSize by the virtualizer's size for the still-UNMEASURED new
    // row — which is its content-aware ESTIMATE, not its real height — so the
    // distance-from-end reads ≈ that estimate; widen the threshold by it so the test
    // reflects the PRE-append distance. Cancelling the real `noteH` instead under-shot:
    // a tall note's estimate overshoots its real height by >scrollEndThreshold (the
    // estimate counts more, shorter lines), so the bottom-pinned user read as "not at
    // end" and the reveal was skipped entirely. `max` also covers the row already
    // being measured (then growth == real >= estimate).
    const estRow = virtualizer.options.estimateSize(count - 1)
    const grewBy = Math.max(noteH, estRow)
    if (!virtualizer.isAtEnd(grewBy + virtualizer.options.scrollEndThreshold)) return

    stop() // cancel + settle any previous in-flight reveal

    // The new note mounts full-size; glide the scroll from one note-height short of the
    // bottom up to the true bottom, so the feed pushes up and the note rises into view.
    // The duration is FIXED, so a bigger note glides a LONGER distance in the same time
    // — it scrolls FASTER, matching the "bigger note ⇒ stronger push" intuition. (On a
    // short, non-overflowing feed there's no room; the note simply appears.)
    // `scrollHeight` still counts the new row at `estRow` (unmeasured this frame); for a
    // tall note that overshoots its real height, so the raw target would aim PAST the true
    // bottom and bump-stop as measureElement corrects scrollHeight mid-glide. Subtract the
    // estimate error so the glide lands on the real bottom (`settle` re-pins after measure).
    const endScroll = scroller.scrollHeight - scroller.clientHeight - (estRow - noteH)
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

    // Duration + easing blended continuously by note size (`revealTween`), so a taller
    // note glides with a longer, gentler curve. Dev slow-mo scales the duration.
    const { duration: baseDur, ease } = revealTween(noteH, scroller.clientHeight)
    const duration = import.meta.env.DEV ? baseDur * (window.__morphSlow ?? 1) : baseDur
    controlsRef.current = animate(startScroll, endScroll, {
      type: 'tween',
      duration,
      ease,
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
