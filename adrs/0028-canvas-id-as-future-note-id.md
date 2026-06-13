# 0028 — `canvas_id` as an opaque text key; no canvases table

Status: accepted (v0.4)

## Context

v0.4 ships exactly one canvas. The obvious modelling reflex — a `canvases` table with a
primary key, a name, and a camera — would name the thing the milestone actually uses.

But the canvas vision treats a canvas as a *projection*, not a top-level entity. The durable
direction (`docs/canvas-vision.md` principle 3) is that **a note's thread is its canvas, one
identity**: when threads arrive, `canvas_id` becomes the parent note's id, and a top-level
canvas is itself a note (`docs/canvas-vision.md` §Multiple canvases). A `canvases` table would
foreclose that identity — it would create a second place where "a canvas" can live, and the
threads/multi-canvas milestones would have to either migrate it away or carry two parallel
notions of canvas-hood forever.

The question this ADR settles: what is the *type and shape* of `canvas_id` such that v0.4 is
correct today and the threads/multi-canvas futures are a thread-through, not a rewrite?

## Decision

`canvas_id` is an **opaque TEXT key**, constant `'root'` in v0.4, threaded explicitly through
every table, every IPC channel, and every query. There is **no canvases table**.

- Both layout tables carry it: `node_layouts.canvas_id` and `canvas_state.canvas_id`
  (`docs/specs/v0.4-canvas-mvp.md` §1).
- Every layout IPC channel takes `canvasId` as an argument — callers pass the constant, they
  never default it (`docs/specs/v0.4-canvas-mvp.md` §2).
- The constant lives in exactly one module, `src/shared/canvas.ts`
  (`ROOT_CANVAS_ID = 'root'`), so the day `canvas_id` stops being a constant there is one place
  to change (`src/shared/canvas.ts:10`).

Because the key is opaque text and threaded everywhere, the future migrations are additive:

- **Threads / nested canvases:** `canvas_id` = the parent note's id. No schema change to the
  layout tables — a new value flows through the existing column.
- **Multiple top-level canvases:** a top-level canvas is itself a note (its id is the
  `canvas_id`, its title is the canvas name); `'root'` stays the one anonymous special case.
  No canvases table is introduced — the note table already holds the name.

## Alternatives

- **A `canvases` table** (PK + name + camera) — rejected. It contradicts
  `docs/canvas-vision.md` principle 3 ("There is no canvases table") and would foreclose the
  note-is-canvas identity that threads and multiple-canvases both depend on. The vision is
  explicit: "do not introduce a canvases table without amending principle 3"
  (`docs/canvas-vision.md` §Multiple canvases). Camera state lives in `canvas_state` keyed by
  `canvas_id` instead — no entity table needed.

## Consequences

- v0.4 pays a tiny ergonomic tax: every IPC call and query carries a `canvasId` that is always
  `'root'`. This is deliberate — it is the seam that makes the futures free.
- **One known sync seam, recorded for the threads spec:** `comment-on` edges target the
  parent's *slug* (`docs/specs/v0.4-canvas-mvp.md` §11, consistent with `backlinks()`), while
  `canvas_id` will be the parent's *id*. The slug↔id join and slug renames are a small real
  sync surface the threads spec must handle (`docs/canvas-vision.md` principle 3). This is named
  now so it is not discovered late.
- Anyone tempted to add a canvases table must amend `docs/canvas-vision.md` principle 3 first —
  that doc is the tripwire.

## Sources

- `docs/canvas-vision.md` principle 3, §Threads + nested canvases, §Multiple canvases
- `docs/specs/v0.4-canvas-mvp.md` §1 (schema), §2 (IPC surface), §16 (Future contracts row 1)
- `src/shared/canvas.ts:10` — the single home of `ROOT_CANVAS_ID`
- ADR 0002 (slug-strict identity) — the slug-vs-id distinction the known seam rides on
