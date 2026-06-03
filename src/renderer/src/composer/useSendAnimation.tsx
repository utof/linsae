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
 * Total flight time (ms) of the send ghost — composer liftoff → feed landing.
 */
const FLIGHT_MS = 460

/**
 * Overshoot of the flight easing (`easeOutBack`'s `c1`). Higher = more dramatic
 * iMessage "bounce" — the bubble springs past its slot and settles back. ~1.7 is
 * the textbook value; we run hotter for drama.
 */
const FLIGHT_OVERSHOOT = 2.6

/**
 * `easeOutBack` — a spring-like overshoot. Rises, shoots PAST 1 near the end,
 * then settles to exactly 1. `easeFlight(0) === 0`, `easeFlight(1) === 1`.
 *
 * Why hand-rolled rAF + this easing instead of Motion's `animate` (which drives
 * the make-room reveal fine): Motion's imperative element-animate runs on the
 * WAAPI ("accelerated") engine, which commits the END keyframe for several frames
 * during startup — on a freshly-mounted ghost that flashes it at the landing spot
 * before the flight (harness-caught as a `ty` dip; neither explicit keyframes,
 * a synchronous pin, nor `onUpdate` suppressed it). A rAF loop paints frame 0 =
 * the liftoff synchronously, guaranteeing no flash (the same approach the
 * expand/collapse morph uses). See ADR 0018 (no-flash) and ADR 0019.
 */
function easeFlight(t: number): number {
  if (t <= 0) return 0
  if (t >= 1) return 1
  const c1 = FLIGHT_OVERSHOOT
  const c3 = c1 + 1
  const p = t - 1
  return 1 + c3 * p * p * p + c1 * p * p
}

/** Liftoff/landing geometry captured synchronously at `launch` time. */
interface Flight {
  body: string
  mode: NoteType
  /** Composer textarea top/left at submit — the ghost's fixed-position anchor. */
  start: { top: number; left: number }
  /**
   * Monotonic id, used as the SendGhost's React `key` so every send mounts a
   * FRESH DOM node. Without it React reconciles the ghost to the SAME node across
   * sends, and that node keeps the previous flight's inline `transform` — which
   * paints for a few frames at the old landing spot before our rAF overwrites it
   * (harness-caught as a destination "flash" at frame 0). A fresh node has no
   * inline transform, so `applyFrame(0)` (the liftoff) is the first thing painted.
   */
  seq: number
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
 * Mechanics (mirroring `useExpandCollapseMorph`'s rAF clock):
 *  - `prefers-reduced-motion: reduce` (or a missing card/scroller ref) → no
 *    ghost, no fly, `inFlight` never flips; the real note simply appears.
 *  - The composer textarea rect is read **synchronously** in `launch`, before the
 *    create mutation's success can remount the composer.
 *  - A layout effect runs once the ghost mounts: it measures the ghost's height,
 *    computes the landing `target` (`sendTarget`; the feed is bottom-anchored so
 *    the slot is always `scrollerBottom - noteH - pad`), applies frame 0 (the
 *    liftoff) synchronously, then runs one rAF clock tweening `transform` via
 *    `easeFlight`'s overshoot. No opacity change — the ghost never fades.
 *  - `window.__morphSlow` (dev-only, GH #49) stretches the tween Nx.
 *  - Overlapping launches: the layout effect cancels any in-flight rAF before
 *    starting the next; unmount cancels too.
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
  const rafRef = useRef<number | null>(null)
  const seqRef = useRef(0)

  const cancelRaf = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
  }, [])

  // Cancel any in-flight rAF when the hook unmounts.
  useEffect(() => cancelRaf, [cancelRaf])

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

      // Lift off from the TEXTAREA (where the text the user just typed lives), not
      // the card's outer top — so the bubble flies UP out of the composer into the
      // feed. Read NOW, before onSuccess remounts the composer.
      const anchor = card.querySelector('textarea') ?? card
      const r = anchor.getBoundingClientRect()
      // Own-send pins to bottom so the landing slot is on-screen.
      scroller.scrollTop = scroller.scrollHeight

      cancelRaf()
      seqRef.current += 1
      setFlight({ body, mode, start: { top: r.top, left: r.left }, seq: seqRef.current })
    },
    [cardRef, scrollerRef, cancelRaf],
  )

  // Mount → measure → tween. `useLayoutEffect` so the ghost is measured and frame
  // 0 (the liftoff) applied BEFORE paint — no flash. Keyed on `flight`: a new
  // launch re-runs this (cleanup cancels the previous rAF first).
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
      // Feed row paddingBottom (Feed.tsx) — land the ghost on the real bubble, not
      // the padded row bottom.
      bottomPad: 6,
    })
    const dx = target.left - start.left
    const dy = target.top - start.top

    const duration = import.meta.env.DEV ? FLIGHT_MS * (window.__morphSlow ?? 1) : FLIGHT_MS
    const applyFrame = (t: number) => {
      const e = easeFlight(t)
      ghost.style.transform = `translate(${dx * e}px, ${dy * e}px)`
    }
    // Frame 0 = the liftoff (e=0 → no translation), synchronously before paint.
    applyFrame(0)

    let startTs: number | null = null
    const tick = (ts: number) => {
      if (startTs === null) startTs = ts
      const t = Math.min(1, (ts - startTs) / duration)
      applyFrame(t)
      if (t < 1) {
        rafRef.current = requestAnimationFrame(tick)
      } else {
        rafRef.current = null
        setFlight(null) // unmount the ghost; the real note is revealed on hand-off
      }
    }
    rafRef.current = requestAnimationFrame(tick)

    return cancelRaf
  }, [flight, scrollerRef, cancelRaf])

  const ghost = flight ? (
    <SendGhost
      key={flight.seq}
      body={flight.body}
      mode={flight.mode}
      top={flight.start.top}
      left={flight.start.left}
      ref={ghostRef}
    />
  ) : null

  return { launch, ghost, inFlight: flight !== null }
}
