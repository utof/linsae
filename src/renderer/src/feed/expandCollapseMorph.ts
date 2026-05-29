/**
 * Pure helpers for the feed's expand/collapse morph. No DOM — the DOM/rAF
 * orchestration lives in `useExpandCollapseMorph`; these are extracted so the
 * scroll-anchor math is unit-testable in jsdom.
 *
 * @see docs/specs/v0.1.3-expand-collapse-animation.md
 */

/** Linear interpolation between `a` and `b` at `t` in [0,1]. */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

/**
 * Builds a CSS-style cubic-bezier easing function with fixed endpoints
 * P0=(0,0), P3=(1,1) and the two given control points. Returns `y` for an
 * input progress `t` ∈ [0,1]: inverts `x(s)` for the bezier parameter `s` via
 * Newton-Raphson (with endpoint short-circuits), then evaluates `y(s)`.
 *
 * Why our own (not a CSS transition): the morph is driven by a manual rAF clock
 * over `resizeItem`/`scrollTop`, not a CSS-animatable property, so we need the
 * curve as a plain function. Output stays within [0,1] for control points with
 * y ∈ [0,1] — no overshoot — which is intentional: an overshooting curve would
 * make a collapse/expand clip exceed its content and resurrect the empty-box
 * blank (ADR 0007).
 */
export function cubicBezier(
  p1x: number,
  p1y: number,
  p2x: number,
  p2y: number,
): (t: number) => number {
  const cx = 3 * p1x
  const bx = 3 * (p2x - p1x) - cx
  const ax = 1 - cx - bx
  const cy = 3 * p1y
  const by = 3 * (p2y - p1y) - cy
  const ay = 1 - cy - by
  const xAt = (s: number) => ((ax * s + bx) * s + cx) * s
  const yAt = (s: number) => ((ay * s + by) * s + cy) * s
  const dxAt = (s: number) => (3 * ax * s + 2 * bx) * s + cx
  return (t: number): number => {
    if (t <= 0) return 0
    if (t >= 1) return 1
    let s = t
    for (let i = 0; i < 8; i++) {
      const x = xAt(s) - t
      if (Math.abs(x) < 1e-5) break
      const d = dxAt(s)
      if (Math.abs(d) < 1e-6) break
      s -= x / d
    }
    return yAt(s)
  }
}

/**
 * The morph's easing: a *slight* ease-in (so the motion is visibly "starting"
 * rather than snapping) into a strong ease-out (decisive settle). Tune the
 * control points here. Symmetric ease-in-out read as too heavy; pure ease-out
 * felt too abrupt at the start.
 */
export const easeMorph = cubicBezier(0.35, 0, 0.2, 1)

/**
 * `scrollTop` that keeps a morphing item's BOTTOM edge fixed on screen
 * (the collapse "ride-up" anchor).
 *
 * `bottomScreenOffset` is captured once at morph start as
 * `(noteStart + startH) - scrollTopStart`. Holding the bottom edge fixed means
 * `(noteStart + h) - scrollTop === bottomScreenOffset`.
 *
 * Why: keeps every note below the morphing one pixel-stable while its height
 * animates — the user keeps their place. See spec §Collapse.
 */
export function bottomAnchorScrollTop(
  noteStart: number,
  h: number,
  bottomScreenOffset: number,
): number {
  return noteStart + h - bottomScreenOffset
}
