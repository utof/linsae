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
- `resizeItem` is wrapped in `flushSync` each frame so the items BELOW the
  morphing one reposition in the SAME frame as its body clip. Without it the
  React re-render lands a frame late, so the note's bottom edge runs one frame
  ahead of the notes below it → a gap opens and chases shut. They must move
  glued together. Verified 60fps with the flushSync (the per-frame render is
  cheap — the React Compiler memoizes the unchanged bubbles);
- `shouldAdjustScrollPositionOnItemSizeChange` is forced to return `false` AND
  `options.anchorTo` is dropped to `'start'` for the morph window. Both are
  needed: `resizeItem`'s `anchorTo:'end'` "wasAtEnd" branch applies a scroll
  adjustment *unconditionally* (not gated by `shouldAdjust`), so on a
  collapse-near-bottom it would double-apply with our manual bottom-anchor and
  overshoot the viewport above all content (feed blanks for the morph). With
  `anchorTo:'start'` + `shouldAdjust:false`, the library does zero resize-driven
  scroll adjustment and our anchor is the sole driver. **Note:**
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

**Collapse keeps the full content mounted through the morph.** The naive
approach (swap to truncated content at click, then shrink the clip) leaves the
clip box taller than its now-short content — an empty white band that reads as
"the note vanished" (confirmed visually via the Playwright-Electron harness,
`scripts/morph-harness.mjs`). Instead, `Feed` measures the collapsed target size
up front via a no-paint `flushSync` content swap (in the click handler, so the
intermediate render is never painted), keeps the full content for the roll-up,
and commits the truncation only at the morph's `finish` (`onCommit`, applied
with `flushSync` before the clip is released so the body's natural height
already matches — no end-of-morph flash). Expand is naturally filled (it reveals
full content as it grows), so it swaps content up front as before.

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
- **Cross-note cancel is handled:** toggling a *different* note within the ~240ms
  morph calls `cancel()`, which now resets the in-flight note's `bodyEl` clip and
  the thumb-suppression flag (the hook tracks the active body in a ref). Without
  this the first note would strand at its interpolated clipped height — it does
  NOT self-heal on re-render, because the clip is imperative `style.height/
  overflow` absent from JSX.
- **Expand near the feed bottom is bottom-pinned, by design of the library.**
  `applyFrame` only writes `scrollTop` on collapse, relying on
  `shouldAdjustScrollPositionOnItemSizeChange` being off to keep expand
  top-anchored. But virtual-core's `resizeItem` runs its own `wasAtEnd` scroll
  adjustment (under `anchorTo:'end'` within `scrollEndThreshold`) independently of
  that predicate, so expanding a note within ~120px of the bottom pins the bottom
  instead of the top. This is the better chat behavior and invisible mid-feed, so
  it is accepted rather than worked around.

## Sources
- tanstack-virtual `resizeItem` / `shouldAdjustScrollPositionOnItemSizeChange` —
  https://tanstack.com/virtual/latest/docs/api/virtualizer
- virtual-core 3.16 source (`dist/esm/index.js`) — confirms the instance-property read.
