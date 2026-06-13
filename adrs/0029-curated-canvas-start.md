# 0029 — Curated start; no whole-vault auto-seed at card tier

Status: accepted (v0.4)

## Context

A spatial canvas over an existing vault invites an obvious first move: on open, drop every note
onto the surface so the user "sees their graph." That is what force-directed whole-vault tools
(Obsidian graph, Roam) do by default.

The canvas vision rejects this. The product thesis is that the canvas is a **thinking space, not
a graph visualization** — the user's spatial memory does the organizing, and the surface "shows
only what was deliberately placed on it" (`docs/canvas-vision.md` §Product thesis). The strongest
prior-art finding backs this: the tools whose spatial surfaces people actually live in
(Heptabase, Scapple, Tinderbox, MarginNote, Muse) are **manual-placement-first**, whereas
force-directed whole-vault graphs "start degrading around ~200 notes and are reliably hairballs
by ~500" (`docs/canvas-vision.md` §Product thesis).

## Decision

The root canvas **begins empty**. Notes appear on the card tier only when **deliberately
placed** (shelf drag-out, `/` picker, one-shot placement from the feed, or double-click-to-
create). There is no auto-seeding ever at the card tier
(`docs/specs/v0.4-canvas-mvp.md` product-decision 3).

Whole-vault projection is not abandoned — it belongs to a different tier. The far-zoom **dot
tier** eventually takes the "where is everything" job: notes without manual positions get
*computed* positions there, never as card-tier auto-scatter
(`docs/canvas-vision.md` principle 6, §Semantic zoom). The dot tier also subsumes the minimap,
which is ruled out permanently.

The first-run **zero state** is the UI consequence: centered in the viewport, copy verbatim
"nothing here yet. / this canvas only shows what you place on it. …", keyed off placed-count, not
a stored flag (`docs/specs/v0.4-canvas-mvp.md` §14).

## Alternatives

- **Auto-seed / force-directed whole-vault graph on open** — rejected. The prior-art research
  is the evidence: manual-placement-first is the validated pattern for surfaces people live in;
  whole-vault force layouts hairball at ~200–500 notes
  (`docs/canvas-vision.md` §Product thesis). Auto-scatter would also undermine the spatial-memory
  bet directly — notes the user did not place have no remembered location.

## Consequences

- The empty-on-open canvas is the **falsifiable form of the product thesis**. Issue #96 holds
  the pre-registered trigger: after ~4 weeks of dogfooding v0.4, **fewer than ~20 manually
  placed notes** falsifies the thinking-space bet and promotes the overview/dot-first direction
  (`docs/canvas-vision.md` §Standing experiments, issue #96). The curated start is what makes
  that count meaningful — a board that auto-fills would never produce the signal.
- Whole-vault projection is deferred to the dot tier, not deleted. A future spec that adds card-
  tier auto-scatter must amend principle 6 first.
- Placement debt stays visible (`N unplaced ●` in the status bar) so the curated surface does
  not silently lose queued notes (`docs/specs/v0.4-canvas-mvp.md` product-decision 4, §14).

## Sources

- `docs/canvas-vision.md` principle 6, §Product thesis, §Semantic zoom, §Standing experiments
- `docs/specs/v0.4-canvas-mvp.md` product-decision 3, §14 (zero state)
- Issue #96 — switchable arrangements + whole-vault placement; the dogfooding falsification
  trigger (<~20 manually placed notes in ~4 weeks)
