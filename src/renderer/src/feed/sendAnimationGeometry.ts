/**
 * Pure geometry helper for the send-note ghost animation. No DOM reads, no
 * React — all inputs are passed in so the math is unit-testable in node-env.
 *
 * The ghost element is rendered `position:fixed` at the composer's bounding
 * rect and flown toward the feed-bottom landing slot. The flight itself is a
 * Motion spring (`useSendAnimation` → `animate(ghost, { x, y }, { type: spring })`);
 * this module only computes WHERE it should land. The easing/opacity used to
 * live here (a hand-rolled cubic-bezier + a fade) — both were dropped when the
 * flight moved to a Motion spring and the ghost stopped fading (it now hands off
 * to the real note instead). See ADR 0019.
 *
 * @see docs/specs/v0.2.1-send-animation.md
 * @see src/renderer/src/composer/useSendAnimation.tsx
 */

// ---------------------------------------------------------------------------
// sendTarget — where the new note lands in the feed
// ---------------------------------------------------------------------------

/**
 * Computes the fixed-position coordinates where the in-flight ghost note
 * should arrive (the "landing spot" at the feed bottom).
 *
 * Single branch because the feed is **bottom-anchored** (chat-style: notes sit
 * flush at the scroller's bottom edge even when the content is shorter than the
 * viewport — `Feed`'s `margin-top:auto` content wrapper). The newest note's top
 * edge is therefore always `scrollerBottom - noteH`, whether the feed scrolls or
 * not. (Before bottom-anchoring, a short top-aligned feed needed a separate
 * `scrollerTop + contentHeight` branch; that case no longer exists.)
 *
 * @see docs/specs/v0.2.1-send-animation.md
 * @see src/renderer/src/feed/Feed.tsx (bottom-anchored layout)
 */
export function sendTarget(input: {
  scrollerBottom: number
  noteH: number
  feedContentLeft: number
  /**
   * The feed row's bottom padding (px). A feed row is the bubble plus
   * `paddingTop`/`paddingBottom` (Feed.tsx); the bubble's bottom edge sits
   * `bottomPad` above the row's bottom, so the ghost (a bare bubble) must land
   * `bottomPad` higher than the row bottom to dissolve onto the real bubble.
   */
  bottomPad: number
}): { top: number; left: number } {
  const { scrollerBottom, noteH, feedContentLeft, bottomPad } = input
  return { top: scrollerBottom - noteH - bottomPad, left: feedContentLeft }
}
