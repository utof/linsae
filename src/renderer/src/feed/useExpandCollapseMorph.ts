import type { Virtualizer } from '@tanstack/react-virtual'
import { useCallback, useEffect, useRef } from 'react'
import { bottomAnchorScrollTop, easeOutCubic, lerp } from './expandCollapseMorph'

const MORPH_MS = 240

interface PendingMorph {
  id: string
  index: number
  start: number
  startItemH: number
  bottomScreenOffset: number
  collapsing: boolean
}

/**
 * Drives the feed's expand/collapse morph: one rAF clock sets the bubble's body
 * clip height, the virtualizer item size (`resizeItem`), and `scrollTop` in
 * lockstep — taking the async `measureElement` out of the animation loop, which
 * is what eliminates the scrollbar jitter and the no-animation race.
 *
 * The morphing item must NOT be observed by `measureElement` while we drive it
 * with `resizeItem` (tanstack: mixing the two on one item is unpredictable), so
 * `Feed` detaches `measureElement` for `morphingIndex` and re-attaches after.
 *
 * Reduced motion (or a missing scroller) → instant final size + anchored scroll.
 *
 * @see docs/specs/v0.1.3-expand-collapse-animation.md
 * @see adrs/0007-animate-virtual-item-resize.md
 */
export function useExpandCollapseMorph(args: {
  // biome-ignore lint/suspicious/noExplicitAny: virtualizer is generic over the scroll element type; the hook only uses index-based APIs.
  virtualizer: Virtualizer<any, any>
  scrollerEl: HTMLElement | null
  setMorphingIndex: (i: number | null) => void
  suppressThumbResizeRef: { current: boolean }
}) {
  const { virtualizer, scrollerEl, setMorphingIndex, suppressThumbResizeRef } = args
  const rafRef = useRef<number | null>(null)
  // The body element of the morph currently in flight, so `cancel` can undo its
  // clip. Without this, toggling a DIFFERENT note mid-morph would strand the
  // first note's body at its interpolated clipped height (it does not self-heal
  // on re-render — the height/overflow are imperative, absent from JSX). ADR 0007.
  const activeBodyRef = useRef<HTMLElement | null>(null)

  // Undo a morph's imperative state. Safe to call mid-flight; idempotent.
  const reset = useCallback(() => {
    const body = activeBodyRef.current
    if (body) {
      body.style.removeProperty('height')
      body.style.removeProperty('overflow')
      activeBodyRef.current = null
    }
    suppressThumbResizeRef.current = false
  }, [suppressThumbResizeRef])

  const cancel = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
    reset()
  }, [reset])

  useEffect(() => cancel, [cancel])

  /**
   * Begin a morph. `pending` carries geometry captured BEFORE the content swap;
   * `bodyEl` is the `[data-bubble-body]` element to clip; `endItemH` is the
   * item's natural height AFTER the swap (measured by the caller post-commit).
   */
  const run = useCallback(
    (pending: PendingMorph, bodyEl: HTMLElement, endItemH: number) => {
      const scroller = scrollerEl
      cancel()
      activeBodyRef.current = bodyEl
      const { index, start, startItemH, bottomScreenOffset, collapsing } = pending

      // Non-body chrome (paddings/border + the expand-row) is constant across
      // expand/collapse. Measure it at the CURRENT (end/natural) state: the body
      // is at endBodyH right now, so nonBodyH = endItemH - endBodyH. (Using
      // startItemH here would mix start-item with end-body — wrong.)
      const nonBodyH = endItemH - bodyEl.getBoundingClientRect().height
      const maxScrollOf = () => (scroller ? scroller.scrollHeight - scroller.clientHeight : 0)
      const applyFrame = (h: number) => {
        bodyEl.style.overflow = 'hidden'
        bodyEl.style.height = `${Math.max(0, h - nonBodyH)}px`
        virtualizer.resizeItem(index, h)
        if (collapsing && scroller) {
          const next = bottomAnchorScrollTop(start, h, bottomScreenOffset)
          scroller.scrollTop = Math.max(0, Math.min(maxScrollOf(), next))
        }
      }
      const finish = () => {
        reset()
        rafRef.current = null
        setMorphingIndex(null) // re-attaches measureElement → final remeasure
      }

      const reduced =
        typeof window !== 'undefined' &&
        window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

      if (reduced || !scroller) {
        applyFrame(endItemH)
        finish()
        return
      }

      suppressThumbResizeRef.current = true
      // Avoid a flash: clamp to the start height for the first painted frame.
      applyFrame(startItemH)
      let startTs: number | null = null
      const tick = (ts: number) => {
        if (startTs === null) startTs = ts
        const t = Math.min(1, (ts - startTs) / MORPH_MS)
        applyFrame(lerp(startItemH, endItemH, easeOutCubic(t)))
        if (t < 1) {
          rafRef.current = requestAnimationFrame(tick)
        } else {
          finish()
        }
      }
      rafRef.current = requestAnimationFrame(tick)
    },
    [virtualizer, scrollerEl, cancel, reset, setMorphingIndex, suppressThumbResizeRef],
  )

  return { run, cancel }
}
