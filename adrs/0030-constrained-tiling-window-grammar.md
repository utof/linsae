# 0030 — Constrained tiling is the window grammar (embryo dock shell)

Status: accepted (v0.4)

## Context

v0.4 needs somewhere to put the shelf. The cheap answer is a fixed sidebar. The expensive answer
is a full windowing system. Either choice quietly commits the app to a window grammar that every
later pane (backlinks, AI chat, PDF, feed-as-pane) inherits — so the grammar, not the shelf, is
the real decision.

The canvas vision fixes the grammar: **constrained tiling** — left dock / center stage / right
dock, tabs as text labels, conditional tab strips, home-dock defaults, drag-to-rearrange as a
pure power feature, and **pay-as-you-go chrome**: "a user who never opens a second pane never
sees a tab" (`docs/canvas-vision.md` principle 7, §Dock shell).

## Decision

v0.4 ships the **embryo** of that grammar — the smallest shape that is structurally the full
grammar, not a throwaway sidebar.

- A data-driven `Pane` registry in `src/renderer/src/panes/` from day one:
  `{ id; title; homeDock: 'left' | 'right'; render }` (`docs/specs/v0.4-canvas-mvp.md` §10).
- v0.4 registers **exactly one pane** (Shelf, `homeDock: 'left'`) and renders **exactly one
  dock** (left).
- **The word "tab" is not earned until ≥2 panes.** With one pane there is no tab strip — just a
  quiet header with the pane title and a close × (the constrained-tiling rule;
  `docs/specs/v0.4-canvas-mvp.md` §10).
- The dock is window chrome, not canvas chrome: it coexists with both stage views (feed and
  canvas). On the feed it works as a reading list of queued notes
  (`docs/specs/v0.4-canvas-mvp.md` §10).
- Dock open/closed + width are in-memory view-state, not persisted in v0.4.

This is pay-as-you-go chrome made literal: the registry is the full mechanism, but the rendered
chrome is exactly what one pane needs and no more.

## Alternatives

- **Free-form / floating windows** — rejected. Contradicts `docs/canvas-vision.md` §Dock shell
  ("constrained tiling is the window grammar … resist the feature-button row"). Floating windows
  trade the spatial predictability the dock grammar buys for placement overhead the product does
  not want.
- **A fixed sidebar** — rejected. It would not be the future grammar; the full dock shell
  (right dock, tab strips at ≥2 panes, home docks, tab dragging) would have to replace it rather
  than grow from it. The `Pane` registry with `homeDock` is the seam that lets the shell grow in
  place (`docs/specs/v0.4-canvas-mvp.md` §16, Future-contracts row "Pane registry with homeDock").

## Consequences

- The full dock shell (right dock; tab strips only at ≥2 panes; per-pane home docks; tab
  dragging between docks as pure rearrangement; content-pane vs utility-pane classes) grows
  from this registry without a rewrite — its forcing functions are backlinks + AI chat panes,
  deliberately not PDF (`docs/canvas-vision.md` §Dock shell).
- v0.4 deliberately omits: right dock, tab strips, tab dragging, a second pane, collapsed shelf
  strip — all the next dock-shell milestone's (`docs/specs/v0.4-canvas-mvp.md` Non-goals, §10).
- No saved workspaces/presets until layouts demonstrably hurt to reconstruct
  (`docs/canvas-vision.md` §Dock shell).

## Sources

- `docs/canvas-vision.md` principle 7, §Dock shell
- `docs/specs/v0.4-canvas-mvp.md` §10 (embryo dock shell), §16 (Future contracts row "Pane
  registry with homeDock"), Non-goals
