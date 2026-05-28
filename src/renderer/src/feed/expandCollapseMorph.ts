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
 * easeOutCubic — fast start, gentle settle. Same shape family as the feed's
 * existing `cubic-bezier(0.22, 1, 0.36, 1)` scrollbar-resize easing.
 */
export function easeOutCubic(t: number): number {
  const c = 1 - t
  return 1 - c * c * c
}

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
