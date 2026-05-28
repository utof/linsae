# 0007 — Animating item resize in a measured virtual list

## Context
Expand/collapse of over-cap feed notes was disorienting (collapse teleported the
reader), un-animated at the feed level (siblings snapped via untransitioned
`translateY`), and jittered the custom scrollbar. Root cause: a height change
relayouts instantly AND the manual height tween kept tanstack-virtual's async
`measureElement` inside the animation loop, and nothing preserved the scroll
anchor across the size delta. See `docs/specs/v0.1.3-expand-collapse-animation.md`.

## Decision
Animate the morph with one synchronous `requestAnimationFrame` clock that drives,
per frame: the body clip height (`[data-bubble-body]`, `overflow:hidden`),
`virtualizer.resizeItem(index, h)`, and `scrollTop`. Collapse anchors the note's
BOTTOM edge (`bottomAnchorScrollTop`, notes below stay fixed); expand stays
top-anchored (no scroll change). For the morph window:

- the animating item detaches `measureElement` (tanstack forbids mixing
  `resizeItem` + `measureElement` on one item — "unpredictable behaviour"), via a
  conditional ref keyed on `morphingIndex`;
- `shouldAdjustScrollPositionOnItemSizeChange` is forced to return `false` so the
  virtualizer's own scroll correction doesn't fight the manual anchor. **Note:**
  in virtual-core 3.16 this is an *instance property* read as
  `this.shouldAdjustScrollPositionOnItemSizeChange` (`dist/esm/index.js`), NOT a
  `VirtualizerOptions` field — so it is set by direct assignment to the
  virtualizer in Feed's render body each render, closing over a `morphingIndexRef`;
- the custom scrollbar's resize transition is suppressed (`useScrollThumb`'s
  optional `suppressResizeRef`) so the thumb tracks the smooth scroll.

Expand state lifts from `NoteBubble` to `Feed` (where the virtualizer lives);
`NoteBubble` becomes presentational about expansion (`expanded` + `onToggleExpand`
props). `prefers-reduced-motion` (or a missing scroller) takes an instant path:
final size + anchored scroll, no tween.

## Alternatives
- **Instant relayout + scroll compensation (no animation):** robust and
  orientation-preserving, but drops the requested animation. Retained as the
  reduced-motion / fallback path inside the same code.
- **Keep the WAAPI height tween + compensate in the measure callback:** leaves the
  async ResizeObserver in the loop — the exact source of the jitter and the
  no-animation race. Rejected.
- **Layout-animation library (Framer Motion et al.):** large dependency that
  fights the virtualizer and the React Compiler; contradicts the inline-style,
  no-Tailwind, rolled-own-scrollbar ethos. Rejected.

## Consequences
- Couples the feed to `resizeItem` and `shouldAdjustScrollPositionOnItemSizeChange`;
  revisit if the virtualization library changes. (The latter being an instance
  property rather than an option is a version-specific detail — re-verify on
  tanstack upgrades.)
- The morphing item briefly stops being measured; a final remeasure on finish
  (re-attaching `measureElement`) reconciles the size.
- Imperatively-set `bodyEl.style.height/overflow` survive React re-renders because
  those properties are absent from the JSX style object (React only reconciles
  properties it sets).
- **Known minor limitation:** toggling a *different* note within the ~240ms morph
  cancels the in-flight rAF but does not reset the previous note's clipped
  `bodyEl`, which can stay clipped until it re-renders or is virtualized out and
  back (self-healing). Rare; acceptable for v0.1.3.

## Sources
- tanstack-virtual `resizeItem` / `shouldAdjustScrollPositionOnItemSizeChange` —
  https://tanstack.com/virtual/latest/docs/api/virtualizer
- virtual-core 3.16 source (`dist/esm/index.js`) — confirms the instance-property read.
