# 0022 — Pluggable feed-entrance animation strategies

Status: accepted (v0.2.2)

## Context

v0.2.2 adds the repulsion-wave entrance alongside the existing scroll-glide. The
question is how to select between them and how to structure the code so future
entrances can be added cleanly.

### Forces

- **Rules of Hooks:** conditional hook calls are forbidden. If `glideReveal` and
  `waveReveal` are both hooks they must both be called unconditionally every
  render, regardless of which is selected.
- **In-flight safety:** a pref change mid-animation should not cancel an in-flight
  wave or glide. The simpler model is: a change applies from the NEXT send, and
  each runner guards its own append effect with an `enabled` flag in the dep array.
- **Agent legibility:** the feed file is already complex (virtualizer wiring,
  scroll anchor, morphing, ghosting). Embedding animation strategy branches inline
  blurs ownership and makes a future third strategy a diff inside the Feed.
- **Isolated testability:** each strategy runner has its own set of inputs
  (`EntranceCtx` slices) and no shared mutable state between runners. They should
  be testable independently.

### Prior state

Before v0.2.2, `useAppendReveal` (the scroll-glide) lived directly inside
`Feed.tsx` — single strategy, no selection concept.

## Decision

**A per-file strategy seam under `src/renderer/src/feed/entrance/`:**

```
entrance/
  types.ts           — FeedEntrance union + EntranceCtx interface
  useEntranceAnimation.ts  — dispatcher hook (always calls every runner, routes by pref)
  glideReveal.ts     — scroll-glide runner (ported from useAppendReveal)
  waveReveal.ts      — wave engine runner (flip + pbd sub-models)
  waveSpring.ts      — pure springStep integrator
  pbdProjection.ts   — pure up-only Gauss-Seidel non-overlap projection
```

`useEntranceAnimation` reads `getFeedEntrance()` per render (a snapshot, not a
subscription — runners re-evaluate their `enabled` gate on the next render after a
pref flip) and calls BOTH `useGlideReveal` and `useWaveReveal` unconditionally.
Each runner receives an `enabled: boolean` that it checks as the first gate inside
its append `useLayoutEffect`; the deselected runner early-returns but still
advances its `prevRef` so a switch back does not misread skipped appends as one
giant append.

The Feed owns all follow-suppression state (`sendInFlight`, `revealing`,
`waveSettling`) and computes `suppressFollow` above `useVirtualizer`; the
dispatcher only forwards the setters a runner needs (`setWaveSettling` for the
wave, `revealingRef`/`setRevealing`/`suppressThumbResizeRef` for glide). Runners
never reach into Feed internals beyond what is passed in `EntranceCtx`.

**Persisted preference: `lib/anim-pref.ts`**

Key `linsae.feedEntrance` in `localStorage`. Valid values: `'glide'` | `'flip'` |
`'pbd'`. An unknown or absent value falls back to `'glide'` (the `getFeedEntrance`
read never throws). The preference is written by `setFeedEntrance`, which also
dispatches a custom `linsae:feed-entrance` event so that `useFeedEntrance` (a
reactive hook) re-renders its caller within the same document — the DOM `storage`
event only fires in OTHER documents. Mirrors `lib/clock-pref.ts` exactly.

**`glide` is the default.** The scroll-glide is the proven, shipped entrance
(v0.2.0 / v0.2.1). The wave is opt-in, bounding the risk of the newer engine. An
unknown stored value always falls back to `glide`, so a future rename does not
leave the user with a blank/broken entrance.

## Alternatives

- **Hardcode one animation (no seam):** simplest, but means ripping out the feed's
  animation logic and re-integrating it every time the strategy changes. The glide
  is not going away; the wave is new; both coexist. A seam is the natural design.
- **`switch (entrance)` inside `Feed.tsx`:** keeps the dispatcher inline but does
  not address the conditional-hook problem (the selected hook can't be called
  conditionally) and makes the Feed file harder to read and test. The per-file
  seam gives each runner an isolated module with its own unit tests
  (`useEntranceAnimation.test.tsx`, `waveSpring.test.ts`, `pbdProjection.test.ts`).
- **A class/object strategy pattern:** more idiomatic for some language contexts,
  but React hooks are not composable as plain objects — the runner hooks need to
  use `useRef`, `useLayoutEffect`, `useCallback`, etc., which require being called
  in a hook context. The hook-per-file approach honours React's rules without
  adapters.
- **Runtime dynamic import (lazy runner):** would allow conditional loading but
  not conditional hook calls. Since the runners are always called, lazy loading
  gains nothing for the hot path and complicates SSR/Electron startup.

## Consequences

- Adding a fourth entrance strategy requires: one new `entrance/fooReveal.ts`
  runner file, one line in `useEntranceAnimation.ts` to always-call it with an
  `enabled` flag, one value added to the `FeedEntrance` union in `types.ts`, and
  one option in the Settings select. No changes to `Feed.tsx` or `anim-pref.ts`.
- Both runners are always called, so there is always two hook sets' worth of
  `useRef`/`useLayoutEffect` overhead even for the deselected strategy. The
  deselected runner's append effect exits at the `!enabled` gate (first check,
  before any DOM reads); the overhead is effectively one comparison per render.
- The following are **explicitly out of scope** for this ADR:
  - The composer-card → note-bubble short morph (Telegram model, planned endgame
    per ADR 0020): it layers on top of an entrance strategy and is a separate
    animation primitive. The `Composer.cardRef` anchor is kept for it.
  - An animation "module" or visual picker: `SettingsPanel.tsx` has a simple `<select>`
    today; a richer picker with previews is deferred.
  - Thread/capture-composer entrance: no thread or capture-composer exists yet.
  - Performance budget tuning for the wave spring constants: STIFFNESS / DAMPING /
    STAGGER_MS are module-level constants in `waveReveal.ts` with a comment
    directing tuning to the DevFpsMeter, not feel.
- `glide` remaining as the default means a new install sees the conservative,
  proven entrance; the wave is discoverable but not forced.

## Sources

- `src/renderer/src/feed/entrance/types.ts` — `FeedEntrance` union + `EntranceCtx`
- `src/renderer/src/feed/entrance/useEntranceAnimation.ts` — dispatcher
- `src/renderer/src/feed/entrance/glideReveal.ts` — scroll-glide runner
- `src/renderer/src/feed/entrance/waveReveal.ts` — wave engine runner
- `src/renderer/src/lib/anim-pref.ts` — `getFeedEntrance` / `setFeedEntrance` /
  `useFeedEntrance`, key `linsae.feedEntrance`, default `'glide'`
- `src/renderer/src/feed/Feed.tsx:273-274` — `useVirtualizer` options fed from
  `suppressFollow`; `src/renderer/src/settings/SettingsPanel.tsx` — entrance
  `<select>` UI
- ADR 0019 (`adrs/0019-motion-animation-library.md`) — Motion adoption
- ADR 0020 (`adrs/0020-remove-send-ghost.md`) — scroll-glide as the base send
  animation; `Composer.cardRef` anchor for future morph
- ADR 0021 (`adrs/0021-per-row-offset-wave-reveal.md`) — wave engine internals and
  the append-guard finding
