/**
 * Pure geometry helpers for the send-note ghost animation. No DOM reads, no
 * React — all inputs are passed in so the math is unit-testable in node-env.
 *
 * The ghost element is rendered `position:fixed` at the composer's bounding
 * rect and animated toward the feed bottom via CSS `transform` + `opacity`.
 * The orchestration (rAF loop, refs, React state) lives in a separate hook;
 * this module is concerned only with the numbers.
 *
 * @see docs/specs/v0.2.1-send-animation.md
 */

import { lerp } from './expandCollapseMorph'

// ---------------------------------------------------------------------------
// SEND_EASE — spring-overshoot timing curve
// ---------------------------------------------------------------------------

/**
 * Evaluates the CSS spring-overshoot timing curve
 * `cubic-bezier(0.34, 1.56, 0.64, 1)` for a given progress `t ∈ [0,1]`.
 *
 * Why: the y2 control point (1.56 > 1) produces an overshoot above 1 before
 * the value settles back to 1 — giving the "bouncy" feel of a message
 * landing in the feed. The curve is evaluated by inverting the parametric
 * x(s) for the bezier parameter `s` (Newton-Raphson, bisection fallback),
 * then reading y(s).
 *
 * `SEND_EASE(0) === 0`, `SEND_EASE(1) === 1` (endpoints exact).
 * Output exceeds 1.0 for some t ∈ (0.5, 1) — intentional overshoot.
 *
 * @see docs/specs/v0.2.1-send-animation.md
 */
export const SEND_EASE: (t: number) => number = (() => {
  // Control points for cubic-bezier(0.34, 1.56, 0.64, 1)
  // P0=(0,0), P1=(0.34, 1.56), P2=(0.64, 1), P3=(1,1)
  const p1x = 0.34
  const p1y = 1.56
  const p2x = 0.64
  const p2y = 1.0

  // Polynomial coefficients for the parametric x(s) and y(s) bezier curves.
  // Standard cubic form: x(s) = ax*s^3 + bx*s^2 + cx*s
  const cx = 3 * p1x
  const bx = 3 * (p2x - p1x) - cx
  const ax = 1 - cx - bx

  const cy = 3 * p1y
  const by = 3 * (p2y - p1y) - cy
  const ay = 1 - cy - by

  const xAt = (s: number): number => ((ax * s + bx) * s + cx) * s
  const yAt = (s: number): number => ((ay * s + by) * s + cy) * s
  const dxAt = (s: number): number => (3 * ax * s + 2 * bx) * s + cx

  return (t: number): number => {
    // Short-circuit exact endpoints to guarantee SEND_EASE(0)===0 and SEND_EASE(1)===1.
    if (t <= 0) return 0
    if (t >= 1) return 1

    // Newton-Raphson: find s such that x(s) === t.
    // Starting estimate s≈t works well for well-behaved x-monotonic curves.
    let s = t
    for (let i = 0; i < 8; i++) {
      const err = xAt(s) - t
      if (Math.abs(err) < 1e-7) break
      const d = dxAt(s)
      if (Math.abs(d) < 1e-8) break // derivative near zero → switch to bisection
      s -= err / d
    }

    // Bisection fallback: if Newton-Raphson converged outside [0,1] or the
    // derivative was too small, bisect to guarantee a correct answer.
    // Why bisection: the overshoot in y does NOT mean x is non-monotonic —
    // x control points 0.34 and 0.64 keep x(s) strictly increasing — but
    // floating-point Newton steps can occasionally wander outside [0,1].
    if (s < 0 || s > 1) {
      let lo = 0
      let hi = 1
      s = t // reset
      for (let i = 0; i < 50; i++) {
        const mid = (lo + hi) / 2
        const xMid = xAt(mid)
        if (Math.abs(xMid - t) < 1e-7) {
          s = mid
          break
        }
        if (xMid < t) lo = mid
        else hi = mid
        s = mid
      }
    }

    return yAt(s)
  }
})()

// ---------------------------------------------------------------------------
// sendTarget — where the new note lands in the feed
// ---------------------------------------------------------------------------

/**
 * Computes the fixed-position coordinates where the in-flight ghost note
 * should arrive (the "landing spot" at the feed bottom).
 *
 * Why two branches:
 * - **Short feed** (`contentHeight + noteH ≤ scrollerHeight`): the virtualizer
 *   is anchored to the end but the total content is shorter than the viewport,
 *   so content starts at `scrollerTop` and the new note would appear immediately
 *   below the existing content → `top = scrollerTop + contentHeight`.
 * - **Tall/scrollable feed** (`contentHeight + noteH > scrollerHeight`): the
 *   feed is bottom-pinned; the newest note's top edge will be
 *   `scrollerBottom - noteH` once the scroll settles.
 *
 * The two formulas agree at the boundary `contentHeight + noteH === scrollerHeight`:
 *   short: `scrollerTop + contentHeight`
 *   tall:  `scrollerBottom - noteH`
 *   Since `scrollerBottom = scrollerTop + scrollerHeight`, both equal
 *   `scrollerTop + contentHeight = scrollerTop + scrollerHeight - noteH`. ✓
 *
 * @see docs/specs/v0.2.1-send-animation.md
 */
export function sendTarget(input: {
  scrollerTop: number
  scrollerBottom: number
  scrollerHeight: number
  contentHeight: number
  noteH: number
  feedContentLeft: number
}): { top: number; left: number } {
  const { scrollerTop, scrollerBottom, contentHeight, noteH, feedContentLeft } = input

  const isShortFeed = contentHeight + noteH <= input.scrollerHeight

  const top = isShortFeed
    ? scrollerTop + contentHeight // note appends below existing content
    : scrollerBottom - noteH // note is pinned flush to the scroller bottom

  return { top, left: feedContentLeft }
}

// ---------------------------------------------------------------------------
// sendFrame — per-frame transform + opacity for the flying ghost
// ---------------------------------------------------------------------------

/**
 * Returns the CSS `transform` (as `tx`/`ty` pixel offsets) and `opacity` for
 * a ghost element rendered `position:fixed` AT the `start` bounding rect,
 * animating toward `target` as `progress` runs from 0 → 1.
 *
 * Why spring-eased translate: the note appears to physically fly from the
 * composer to its landing spot with a bouncy overshoot — `SEND_EASE` drives
 * both axes so the trajectory matches the spring feel.
 *
 * Why raw-progress opacity: the fade-out should be time-linear (the user
 * perceives the ghost disappearing at a steady rate), independent of the
 * eased spatial position. Coupling opacity to the eased value would produce
 * a fast fade during overshoot and a slow re-appearance during settle, which
 * reads as a flicker.
 *
 * `lerp` from `expandCollapseMorph` is used for the opacity fade segment
 * to avoid re-implementing linear interpolation.
 *
 * @see docs/specs/v0.2.1-send-animation.md
 */
export function sendFrame(
  progress: number,
  start: { top: number; left: number },
  target: { top: number; left: number },
): { tx: number; ty: number; opacity: number } {
  const eased = SEND_EASE(progress)

  // `+ 0` converts IEEE-754 negative zero to positive zero so callers always
  // receive a plain `0` when progress=0 (eased=0) regardless of delta sign.
  const tx = (target.left - start.left) * eased + 0
  const ty = (target.top - start.top) * eased + 0

  // Opacity: fully visible until progress=0.6, then linearly fade to 0 by progress=1.
  // lerp (shared with expandCollapseMorph) does the 1→0 fade over the last 40%.
  const opacity = progress < 0.6 ? 1 : Math.max(0, lerp(1, 0, (progress - 0.6) / 0.4))

  return { tx, ty, opacity }
}
