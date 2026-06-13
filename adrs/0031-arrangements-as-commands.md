# 0031 — Arrangements as commands; `arrangement_id` a dormant key

Status: accepted (v0.4)

## Context

`node_layouts` carries an `arrangement_id` column, defaulting to `'manual'`, and only `'manual'`
rows exist in v0.4 (`docs/specs/v0.4-canvas-mvp.md` §1). The column exists for a future the
milestone does not build: computed layouts (timeline, tidy-tree, grid, seed-scatter). The
question the column's mere presence raises — and that this ADR settles — is **what shape**
computed layouts will take when they ship, because that shape determines whether the dormant key
is a stub for the right thing.

Two shapes are possible. (a) **Parallel switchable arrangements:** each `arrangement_id` is a
distinct stored layout the user toggles between, like named views. (b) **Commands that mutate
the manual arrangement:** computed layouts run on-demand, locally, and undoably, *overwriting*
positions in the one manual arrangement.

## Decision

`arrangement_id` is a **dormant key** — present in the schema, constant `'manual'` in v0.4
(`docs/specs/v0.4-canvas-mvp.md` §1). When computed layouts ship they will be **commands** that
*mutate the manual arrangement* — local, on-demand, undoable mutations — **not** parallel
switchable arrangements (`docs/canvas-vision.md` principle 4, §Layout engine).

The vision is explicit: "Auto-layout exists only as on-demand, local, undoable *commands* —
never as the default arrangement" (`docs/canvas-vision.md` §Product thesis); "Computed layouts
ship as commands that *mutate* the manual arrangement; parallel switchable arrangements stay out
of the product unless dogfooding demands them" (`docs/canvas-vision.md` principle 4). The layout
engine delivers "arrangement commands: arrange-selection-as-timeline / tidy-tree / grid,
seed-scatter for a shelf batch — all local, on-demand, undoable mutations of the manual
arrangement" (`docs/canvas-vision.md` §Layout engine).

## Alternatives

- **Parallel switchable arrangements** (each `arrangement_id` a togglable stored view) —
  rejected/deferred. It stays out of the product unless dogfooding demands it; **issue #96 holds
  the revisit trigger** (`docs/canvas-vision.md` principle 4). A standing argument against it,
  recorded in the vision: a recomputed arrangement must never orphan ink, and **strokes belong
  to the manual arrangement only** — so switchable arrangements would have to answer "which
  arrangement owns this stroke," a question the commands-mutate-manual model never raises
  (`docs/canvas-vision.md` §Canvas ink, "one of the standing arguments against switchable
  arrangements (#96)").

## Consequences

- Keeping `arrangement_id` as a column (rather than dropping it) means the layout-engine
  milestone is a thread-through, not a migration — but the column being dormant signals that v0.4
  makes no commitment to switchable semantics. The default `'manual'` is the only arrangement
  that exists, matching the commands-mutate-manual decision.
- Spatial undo is built around single-arrangement mutation from day one
  (`docs/specs/v0.4-canvas-mvp.md` §13) — exactly what arrangement *commands* need, and what
  parallel arrangements would not (toggling views is not an undoable mutation).
- If dogfooding fires the #96 trigger and the team chooses switchable arrangements anyway, the
  ink-ownership question above must be answered first.

## Sources

- `docs/canvas-vision.md` principle 4, §Product thesis, §Layout engine, §Canvas ink (the
  ink-ownership argument against switchable arrangements)
- `docs/specs/v0.4-canvas-mvp.md` §1 (dormant `arrangement_id`), §13 (spatial undo), §16
  (Future contracts row "arrangement_id dormant key")
- Issue #96 — the switchable-arrangements revisit trigger
