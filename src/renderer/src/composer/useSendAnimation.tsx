import { animate, spring } from 'motion'
import {
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import type { NoteType } from '../../../shared/types'
import { sendTarget } from '../feed/sendAnimationGeometry'
import { SendGhost } from './SendGhost'

/**
 * Perceived flight time (seconds) of the send ghost — composer liftoff → feed
 * landing — and the spring's bounce. A high `bounce` gives the dramatic iMessage
 * overshoot (the bubble springs up past its slot and settles back). Tuned to be
 * slightly LONGER than the feed's make-room reveal (`useAppendReveal`, ~0.4s) so
 * the real note has finished sliding into its slot by the time the ghost lands
 * and hands off. Dev slow-mo via `window.__morphSlow`.
 */
const FLIGHT_VISUAL_DURATION = 0.5
const FLIGHT_BOUNCE = 0.5

/** Liftoff/landing geometry captured synchronously at `launch` time. */
interface Flight {
  body: string
  mode: NoteType
  /** Composer card top/left at submit — the ghost's fixed-position anchor. */
  start: { top: number; left: number }
}

/**
 * Drives the iMessage-style "ghost note flies from the composer into the feed"
 * animation. Returns `launch(body, mode)` to fire a flight, the `ghost` ReactNode
 * to render, and `inFlight` — true while a ghost is animating, which the feed
 * uses to hide the real (just-created) note until the ghost lands, so there is
 * never a "double note" on screen and no cross-fade is needed (the ghost simply
 * BECOMES the note on landing).
 *
 * Why a ghost clone instead of animating the real virtualized item: the real
 * note arrives asynchronously (IPC → SQLite → refetch) and lives inside the
 * virtualizer's `translateY` transform, so it cannot be cleanly tweened. A
 * `position:fixed` portal clone (SendGhost) escapes that entirely — see ADR
 * 0018 and SendGhost.tsx.
 *
 * Mechanics:
 *  - `prefers-reduced-motion: reduce` (or a missing card/scroller ref) → no
 *    ghost, no fly, `inFlight` never flips; the real note simply appears.
 *  - The composer card rect is read **synchronously** in `launch`, before the
 *    create mutation's success can remount the composer.
 *  - A layout effect runs once the ghost mounts: it measures the ghost's height,
 *    computes the landing `target` (`sendTarget`; the feed is bottom-anchored so
 *    the slot is always `scrollerBottom - noteH`), and springs the ghost there
 *    via Motion's imperative `animate(ghost, { x, y }, { type: spring })` — a
 *    high-bounce overshoot, no opacity change. `onComplete` unmounts the ghost.
 *  - `window.__morphSlow` (dev-only, GH #49) stretches the tween Nx.
 *  - Overlapping launches: the layout effect stops any in-flight animation
 *    before starting the next; unmount stops too.
 *
 * @see docs/specs/v0.2.1-send-animation.md
 * @see adrs/0019-motion-animation-library.md
 * @see src/renderer/src/feed/useAppendReveal.ts (the make-room half + the hide-until-landing)
 */
export function useSendAnimation(args: {
  cardRef: RefObject<HTMLDivElement | null>
  scrollerRef: RefObject<HTMLDivElement | null>
}): { launch: (body: string, mode: NoteType) => void; ghost: ReactNode; inFlight: boolean } {
  const { cardRef, scrollerRef } = args
  const [flight, setFlight] = useState<Flight | null>(null)
  const ghostRef = useRef<HTMLDivElement | null>(null)
  const controlsRef = useRef<{ stop: () => void } | null>(null)

  const stop = useCallback(() => {
    controlsRef.current?.stop()
    controlsRef.current = null
  }, [])

  // Stop any in-flight animation when the hook unmounts.
  useEffect(() => stop, [stop])

  const launch = useCallback(
    (body: string, mode: NoteType) => {
      const reduced =
        typeof window !== 'undefined' &&
        window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
      // Reduced motion, or no composer/feed to fly between (e.g. first-ever send
      // with the empty-state placeholder rendered instead of <Feed>) → no ghost.
      if (reduced) return
      const card = cardRef.current
      const scroller = scrollerRef.current
      if (!card || !scroller) return

      // Read the liftoff rect NOW, before onSuccess can remount the composer.
      const r = card.getBoundingClientRect()
      // Own-send pins to bottom so the landing slot is on-screen.
      scroller.scrollTop = scroller.scrollHeight

      stop()
      setFlight({ body, mode, start: { top: r.top, left: r.left } })
    },
    [cardRef, scrollerRef, stop],
  )

  // Mount → measure → spring. `useLayoutEffect` so the ghost is measured and the
  // animation kicked off BEFORE paint (the ghost's first painted frame is its
  // composer start position — no flash). Keyed on `flight`: a new launch re-runs
  // this (stopping the previous animation first).
  useLayoutEffect(() => {
    if (!flight) return
    const ghost = ghostRef.current
    const scroller = scrollerRef.current
    if (!ghost || !scroller) {
      setFlight(null)
      return
    }

    const start = flight.start
    const noteH = ghost.getBoundingClientRect().height
    const sr = scroller.getBoundingClientRect()
    const target = sendTarget({
      scrollerBottom: sr.bottom,
      noteH,
      // Notes are left-aligned in the centered column, so the column's left edge
      // ≈ the scroller's left edge. Harness-confirmed: Δleft 0.
      feedContentLeft: sr.left,
    })

    const dx = target.left - start.left
    const dy = target.top - start.top
    // Dev-only slow-mo (GH #49); `import.meta.env.DEV` is literal false in prod.
    const duration = import.meta.env.DEV
      ? FLIGHT_VISUAL_DURATION * (window.__morphSlow ?? 1)
      : FLIGHT_VISUAL_DURATION

    controlsRef.current = animate(
      ghost,
      { x: [0, dx], y: [0, dy] },
      {
        type: spring,
        bounce: FLIGHT_BOUNCE,
        visualDuration: duration,
        onComplete: () => {
          controlsRef.current = null
          setFlight(null) // unmount the ghost; the real note is revealed in step
        },
      },
    )

    return stop
  }, [flight, scrollerRef, stop])

  const ghost = flight ? (
    <SendGhost
      body={flight.body}
      mode={flight.mode}
      top={flight.start.top}
      left={flight.start.left}
      ref={ghostRef}
    />
  ) : null

  return { launch, ghost, inFlight: flight !== null }
}
