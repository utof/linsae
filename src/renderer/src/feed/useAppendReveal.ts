import type { Virtualizer } from '@tanstack/react-virtual'
import { animate, spring } from 'motion'
import { type RefObject, useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import type { Note } from '../../../shared/types'

/**
 * Spring "visual duration" (seconds) of the make-room reveal — how long the feed
 * takes to slide a freshly-appended note up into its slot — and the spring's
 * bounce. Kept slightly SHORTER than the ghost flight (`useSendAnimation`, ~0.5s)
 * so the note has settled into place by the time the ghost lands and hands off.
 * Dev slow-mo via `window.__morphSlow`.
 */
const REVEAL_VISUAL_DURATION = 0.4
const REVEAL_BOUNCE = 0.18

/**
 * Makes a newly-sent note **push the whole feed up** as it stuffs itself into
 * place — the iMessage "the conversation makes room" half of the send animation
 * (the ghost flight is the other half, see `useSendAnimation`).
 *
 * How: the feed is bottom-anchored (`Feed`'s `margin-top:auto` wrapper), so a new
 * bottom note shifts every existing note up by its height in a single layout
 * step. To animate that, we translate the **content wrapper** (the element whose
 * height is the virtualizer's `getTotalSize`) down by the new note's height
 * *before paint*, then spring that translate back to 0 — existing notes glide up
 * and out the top, the new note rises in from the bottom. This is a pure visual
 * `transform`; it never touches `scrollTop`, so it can't fight the virtualizer
 * (cf. the scrollTop-driven morph) and it works identically whether the feed
 * scrolls (tall) or not (short). No Motion `layout` projection — ADR 0019.
 *
 * During the reveal the caller flips the virtualizer to `anchorTo:'start'` and
 * suppresses its size-change scroll correction (the `revealing` flag, shared with
 * the morph) so a `measureElement` estimate→real correction on the new row can't
 * jump `scrollTop` out from under the transform. `onComplete` clears the
 * transform and re-pins to the true bottom.
 *
 * No-ops (the note just appears) for: reduced motion, a bulk/initial load (more
 * than one note added at once), the user being scrolled away from the bottom, or
 * a missing content wrapper.
 *
 * @see adrs/0019-motion-animation-library.md
 * @see src/renderer/src/composer/useSendAnimation.tsx (the ghost-flight half)
 */
export function useAppendReveal(args: {
  // biome-ignore lint/suspicious/noExplicitAny: virtualizer is generic over the scroll element type; the hook only uses index-agnostic APIs.
  virtualizer: Virtualizer<any, any>
  scrollerEl: HTMLElement | null
  /** The content wrapper (height = getTotalSize) whose transform we animate. */
  contentRef: RefObject<HTMLElement | null>
  notes: Note[]
  /** Live flag the caller reads at render time to gate anchorTo/shouldAdjust. */
  revealingRef: { current: boolean }
  /** Re-renders the caller so the gated virtualizer options re-apply. */
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
  // Previous list shape, to detect a single append. Initialised to the first
  // render's value so the initial mount (empty → loaded list) is never an append.
  const prevRef = useRef<{ count: number; lastId: string | undefined }>({
    count: notes.length,
    lastId: notes[notes.length - 1]?.id,
  })

  const stop = useCallback(() => {
    controlsRef.current?.stop()
    controlsRef.current = null
    const content = contentRef.current
    if (content) content.style.transform = ''
    revealingRef.current = false
    suppressThumbResizeRef.current = false
  }, [contentRef, revealingRef, suppressThumbResizeRef])

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
    // Only when the append left us pinned to the new bottom (the user wasn't
    // browsing history); otherwise the note landed off-screen and needs no reveal.
    if (!virtualizer.isAtEnd()) return

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

    stop()
    revealingRef.current = true
    setRevealing(true) // re-render → anchorTo:'start' + size-correction suppressed
    suppressThumbResizeRef.current = true
    // Push the whole content down by one note height BEFORE paint, so the new
    // note starts below the fold and nothing has visibly jumped yet.
    content.style.transform = `translateY(${noteH}px)`

    const duration = import.meta.env.DEV
      ? REVEAL_VISUAL_DURATION * (window.__morphSlow ?? 1)
      : REVEAL_VISUAL_DURATION
    controlsRef.current = animate(
      content,
      { y: [noteH, 0] },
      {
        type: spring,
        bounce: REVEAL_BOUNCE,
        visualDuration: duration,
        onComplete: () => {
          content.style.transform = ''
          controlsRef.current = null
          revealingRef.current = false
          setRevealing(false)
          suppressThumbResizeRef.current = false
          // Re-pin to the true bottom — a measure correction during the reveal can
          // have shifted it (anchorTo was 'start', so it wasn't tracked).
          virtualizer.scrollToEnd?.()
        },
      },
    )
  }, [
    notes,
    scrollerEl,
    contentRef,
    virtualizer,
    stop,
    setRevealing,
    revealingRef,
    suppressThumbResizeRef,
  ])
}
