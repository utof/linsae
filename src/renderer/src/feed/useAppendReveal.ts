import type { Virtualizer } from '@tanstack/react-virtual'
import { animate, spring } from 'motion'
import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import type { Note } from '../../../shared/types'

/**
 * Spring "visual duration" (seconds) of the make-room reveal — how long the feed
 * takes to slide the freshly-appended note up into its slot. Tuned by feel
 * alongside the send ghost's 400ms flight (`useSendAnimation`) so the ghost is
 * fading out over the same window the real note is sliding in. `bounce` is kept
 * small: any spring overshoot past the bottom is harmlessly clamped by the
 * browser's `scrollTop` ceiling, so a low value just gives a clean decelerating
 * settle rather than a visible bounce. Dev slow-mo via `window.__morphSlow`.
 */
const REVEAL_VISUAL_DURATION = 0.42
const REVEAL_BOUNCE = 0.12

/**
 * Makes a newly-sent note **slide up into place** instead of popping in — the
 * iMessage "the conversation makes room" half of the send animation (the ghost
 * flight is the other half, see `useSendAnimation`).
 *
 * Why this lives in `Feed` and drives `scrollTop` (not a Motion layout
 * animation): the feed is virtualized — rows are positioned with
 * `transform: translateY(...)` and the destination row arrives asynchronously
 * (IPC → SQLite → refetch). Motion's `layout`/`layoutId` projection fights that
 * transform and silently no-ops on async-inserted rows (ADR 0019, TanStack
 * virtual #693). So we animate the one thing the virtualizer natively
 * understands — the scroll position — exactly as `useExpandCollapseMorph` does.
 *
 * Mechanics:
 *  1. When `notes` grows by exactly one appended note AND the append pinned us to
 *     the new bottom (`isAtEnd()` — i.e. the user wasn't browsing history),
 *     measure the new row's real height from its DOM node.
 *  2. Rewind `scrollTop` up by that height **synchronously in a layout effect**,
 *     before paint — so the virtualizer's instant bottom-pin is never shown.
 *  3. Spring `scrollTop` back down to the true bottom: existing notes glide up
 *     and the new note rises into its slot.
 *
 * During the reveal the caller flips the virtualizer to `anchorTo: 'start'` and
 * suppresses its size-change scroll correction (via the same `revealing` flag it
 * already uses for the morph), so an estimate→measured size correction on the
 * new row can't yank `scrollTop` mid-animation. `onComplete` snaps to the exact
 * bottom to absorb any residual drift.
 *
 * No-ops (the note just appears) for: reduced motion, a short feed (no scroll to
 * animate), a bulk/initial load (more than one note added at once), or the user
 * being scrolled away from the bottom.
 *
 * @see adrs/0019-motion-animation-library.md
 * @see src/renderer/src/feed/useExpandCollapseMorph.ts (mirrored scrollTop-driving + suppression)
 * @see src/renderer/src/composer/useSendAnimation.tsx (the ghost-flight half)
 */
export function useAppendReveal(args: {
  // biome-ignore lint/suspicious/noExplicitAny: virtualizer is generic over the scroll element type; the hook only uses index-agnostic APIs.
  virtualizer: Virtualizer<any, any>
  scrollerEl: HTMLElement | null
  notes: Note[]
  /** Live flag the caller reads at render time to gate anchorTo/shouldAdjust. */
  revealingRef: { current: boolean }
  /** Re-renders the caller so the gated virtualizer options re-apply. */
  setRevealing: (v: boolean) => void
  /** Shared with the morph: pauses the scrollbar thumb while we drive scroll. */
  suppressThumbResizeRef: { current: boolean }
}) {
  const { virtualizer, scrollerEl, notes, revealingRef, setRevealing, suppressThumbResizeRef } =
    args
  const controlsRef = useRef<{ stop: () => void } | null>(null)
  // Previous list shape, to detect a single append. Initialised to the first
  // render's value so the initial mount (empty → loaded list) is never treated
  // as an append.
  const prevRef = useRef<{ count: number; lastId: string | undefined }>({
    count: notes.length,
    lastId: notes[notes.length - 1]?.id,
  })

  const stop = useCallback(() => {
    controlsRef.current?.stop()
    controlsRef.current = null
    revealingRef.current = false
    suppressThumbResizeRef.current = false
  }, [revealingRef, suppressThumbResizeRef])

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
    // Only when the append left us pinned to the new bottom (followOnAppend
    // engaged); otherwise the note landed off-screen above and needs no reveal.
    if (!virtualizer.isAtEnd()) return

    const reduced =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    if (reduced) return

    // Real height of the appended row from its DOM node (layout effect → the
    // node is laid out; using the measured height, not the size estimate).
    const node = scroller.querySelector<HTMLElement>(`[data-index="${count - 1}"]`)
    if (!node) return
    const noteH = node.getBoundingClientRect().height
    if (noteH <= 0) return

    const target = scroller.scrollHeight - scroller.clientHeight
    // Short feed: nothing to scroll, the note simply appears below existing
    // content (no abrupt upward shift to smooth). Leave it.
    if (target <= 0) return
    const start = Math.max(0, target - noteH)

    stop()
    revealingRef.current = true
    setRevealing(true) // re-render → anchorTo:'start' + size-correction suppressed
    suppressThumbResizeRef.current = true
    // Rewind before paint: the user never sees the virtualizer's instant pin.
    scroller.scrollTop = start

    const duration = import.meta.env.DEV
      ? REVEAL_VISUAL_DURATION * (window.__morphSlow ?? 1)
      : REVEAL_VISUAL_DURATION
    controlsRef.current = animate(0, 1, {
      type: spring,
      bounce: REVEAL_BOUNCE,
      visualDuration: duration,
      onUpdate: (t) => {
        scroller.scrollTop = start + (target - start) * t
      },
      onComplete: () => {
        // Snap to the true bottom — an estimate→measured correction during the
        // reveal can shift the real bottom a few px from `target`.
        scroller.scrollTop = scroller.scrollHeight - scroller.clientHeight
        controlsRef.current = null
        revealingRef.current = false
        setRevealing(false)
        suppressThumbResizeRef.current = false
      },
    })
  }, [notes, scrollerEl, virtualizer, stop, setRevealing, revealingRef, suppressThumbResizeRef])
}
