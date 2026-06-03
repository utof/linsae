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
import { sendFrame, sendTarget } from '../feed/sendAnimationGeometry'
import { SendGhost } from './SendGhost'

/**
 * Total flight time (ms) of the send ghost — composer liftoff → feed landing.
 * Mirrors `useExpandCollapseMorph`'s `MORPH_MS` constant; tuned by feel, not
 * by a spec number. The spring overshoot (`SEND_EASE`) settles within this
 * window. See GH #49 for the dev-only slow-mo multiplier.
 */
const DURATION_MS = 400

/** Liftoff/landing geometry captured synchronously at `launch` time. */
interface Flight {
  body: string
  mode: NoteType
  /** Composer card top/left at submit — the ghost's fixed-position anchor. */
  start: { top: number; left: number }
}

/**
 * Drives the iMessage-style "ghost note flies from the composer into the feed"
 * animation. Returns `launch(body, mode)` to fire a flight and a `ghost`
 * ReactNode to render in the tree.
 *
 * Why a ghost clone instead of animating the real virtualized item: the real
 * note arrives asynchronously (IPC → SQLite → refetch) and lives inside the
 * virtualizer's `translateY` transform, so it cannot be cleanly tweened. A
 * `position:fixed` portal clone (SendGhost) escapes that entirely — see ADR
 * 0018 and SendGhost.tsx.
 *
 * Mechanics, mirroring `useExpandCollapseMorph`:
 *  - `prefers-reduced-motion: reduce` (or a missing card/scroller ref) → no
 *    ghost, no fly; the real note simply appears via the normal mutation.
 *  - The composer card rect is read **synchronously** in `launch`, before the
 *    create mutation's success can remount the composer (the remount is driven
 *    by App's `successCount`), so there is no start-rect race.
 *  - A layout effect runs once the ghost mounts: it measures the ghost's height
 *    (`noteH`), reads the scroller geometry, computes the landing `target` via
 *    `sendTarget`, then runs one rAF clock setting `transform`/`opacity` per
 *    frame from `sendFrame`. At `t>=1` the ghost unmounts.
 *  - `window.__morphSlow` (dev-only, GH #49) stretches the tween Nx; gated by
 *    `import.meta.env.DEV` so it tree-shakes to the constant in prod.
 *  - Overlapping launches: the layout effect keyed on the flight cancels any
 *    in-flight rAF before starting the new one; unmount cancels too.
 *
 * @see docs/specs/v0.2.1-send-animation.md
 * @see src/renderer/src/feed/useExpandCollapseMorph.ts (mirrored rAF/reduced-motion/__morphSlow idioms)
 */
export function useSendAnimation(args: {
  cardRef: RefObject<HTMLDivElement | null>
  scrollerRef: RefObject<HTMLDivElement | null>
}): { launch: (body: string, mode: NoteType) => void; ghost: ReactNode } {
  const { cardRef, scrollerRef } = args
  const [flight, setFlight] = useState<Flight | null>(null)
  const ghostRef = useRef<HTMLDivElement | null>(null)
  const rafRef = useRef<number | null>(null)

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

      // Read the liftoff rect NOW, before onSuccess can remount the composer.
      const r = card.getBoundingClientRect()
      // Own-send pins to bottom so the landing slot is on-screen (instant is
      // fine for v1 — the spec defers smooth pre-scroll).
      scroller.scrollTop = scroller.scrollHeight

      cancelRaf()
      setFlight({ body, mode, start: { top: r.top, left: r.left } })
    },
    [cardRef, scrollerRef, cancelRaf],
  )

  // Mount → measure → tween. `useLayoutEffect` (not `useEffect`) so the ghost is
  // measured and the first frame applied BEFORE paint — no flash of an
  // un-transformed ghost at full opacity (mirrors useExpandCollapseMorph
  // applying its first frame synchronously). Keyed on `flight`: a new launch
  // re-runs this effect (cleanup cancels the previous rAF first), so overlapping
  // sends don't strand a stale clock. All reactive deps (`flight`, `scrollerRef`,
  // `cancelRaf`) are listed; `ghostRef`/`rafRef` are refs and exempt.
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
    // True content height = the virtual content wrapper (scroller's child, sized
    // to the virtualizer's getTotalSize, Feed.tsx). NOT scroller.scrollHeight —
    // that is clamped to at least clientHeight, so on a short (content < viewport)
    // feed it equals clientHeight, the short-feed branch in sendTarget never
    // fires, and the ghost flies to the empty bottom of the scroller instead of
    // the top-aligned landing slot. (send-harness caught this as Δtop 245px.)
    const contentEl = scroller.firstElementChild
    const contentHeight = contentEl
      ? contentEl.getBoundingClientRect().height
      : scroller.scrollHeight
    const target = sendTarget({
      scrollerTop: sr.top,
      scrollerBottom: sr.bottom,
      scrollerHeight: scroller.clientHeight,
      contentHeight,
      noteH,
      // Notes are left-aligned in the centered column, so the column's left edge
      // ≈ the scroller's left edge. Harness-confirmed: Δleft 0.
      feedContentLeft: sr.left,
    })

    // Dev-only slow-mo: `window.__morphSlow = 8` stretches the tween Nx for
    // at-8× feel tuning. `import.meta.env.DEV` is a literal `false` in prod, so
    // this collapses to `DURATION_MS` and tree-shakes out. See GH #49.
    const duration = import.meta.env.DEV ? DURATION_MS * (window.__morphSlow ?? 1) : DURATION_MS

    const applyFrame = (t: number) => {
      const { tx, ty, opacity } = sendFrame(t, start, target)
      ghost.style.transform = `translate(${tx}px, ${ty}px)`
      ghost.style.opacity = `${opacity}`
    }
    // Apply t=0 synchronously inside the layout effect (before paint) so the
    // ghost's first painted frame is its real start state — the no-flash
    // guarantee is enforced here, not left to sendFrame(0) coincidentally
    // returning identity. Mirrors useExpandCollapseMorph's synchronous first
    // applyFrame (line ~120).
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
        setFlight(null)
      }
    }
    rafRef.current = requestAnimationFrame(tick)

    return cancelRaf
  }, [flight, scrollerRef, cancelRaf])

  const ghost = flight ? (
    <SendGhost
      body={flight.body}
      mode={flight.mode}
      top={flight.start.top}
      left={flight.start.left}
      ref={ghostRef}
    />
  ) : null

  return { launch, ghost }
}
