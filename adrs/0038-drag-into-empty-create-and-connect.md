# 0038 — Drag-into-empty creates-or-connects in one gesture; edge ops outside the layout-undo stack; ctrl is the edge modifier

Status: accepted (v0.4.1)

## Context

Three inter-related design decisions were needed for the edge-creation gesture:

1. **Drop-in-empty behaviour.** Dragging an edge handle and releasing over empty canvas space
   needs a target. The options were: cancel the drag, open a picker at the cursor, or
   auto-create a blank note.

2. **Undo model for edges.** The v0.4 layout-undo stack (§13) records `'place'` / `'move'` /
   `'delete-place'` ops over `node_layouts` — spatial, not data. Drawn-edge rows live in `links`,
   not `node_layouts`. Putting edge create/delete into the same undo stack would mix data ops
   with spatial ops.

3. **Modifier scheme.** The canvas already uses left-drag for move, shift/meta-drag for additive
   selection, and the connect-handle for edge-start. A modifier for plain-edge vs. labeled-edge
   dragging had to avoid ctrl (which was additive selection in v0.4).

## Decision

**(a) Drop-in-empty:** releasing the edge handle over empty space opens a cmdk target picker
positioned at the drop point. The picker resolves to an existing note OR creates a new one, and
**places it at the drop point AND connects it** in a single gesture. Both endpoints are placed
immediately so the edge renders at once. "Create new note" uses the typed query as the title.

**(b) Undo model:** edge create/delete are **NOT** in the §13 spatial-undo stack. They are data
ops; `⌘Z` operates on the layout stack only. A known wrinkle: after drop-in-empty, `⌘Z`
un-places the newly placed target note (removes its `node_layouts` row) → the edge hides
(dangling target). The stale `links` row is cleaned up via select + `⌫`. This wrinkle is
documented in `docs/specs/v0.4.1-canvas-edges.md` §4.

**(c) Modifier remap:** additive selection is now `shift || meta` (dropping `ctrl`). `ctrl`-drag
= plain edge (`edge_type='link'`); `ctrl+alt`-drag = labeled edge (opens a type-field input at
drag-start). The hover connect-handle always starts a plain or labeled edge (no modifier needed).
On macOS `meta` (⌘) covers additive; on Linux/Windows `shift` is the universal additive
modifier, freeing `ctrl` for the edge role.

## Alternatives

- **Edge ops in the layout-undo stack now** — rejected. The canvas vision §Full undo absorbs
  content + edge + layout history together in a future milestone; a partial edge-undo now would
  diverge from that unified model and create migration debt. The documented wrinkle is
  preferable to premature partial-undo.
- **Keep ctrl additive + a different edge modifier** — rejected. `ctrl`-drag is the discoverable
  power path (no handle required); on macOS `meta` already covers additive selection, so `ctrl`
  is free. On Linux/Windows `shift` is universal for additive; `ctrl`-drag for edges is
  conventional (Figma, Miro). A rarer modifier (e.g. `alt`-drag) would be less discoverable.
- **Cancel drag on empty-space release** — rejected. A one-gesture create-and-connect is the
  highest-value interaction for knowledge-graph authoring; cancelling and requiring a two-step
  flow raises friction.

## Consequences

- **Behaviour change:** `ctrl` no longer adds to selection; it starts an edge drag. Users who
  relied on ctrl-click for additive select must switch to `shift`-click or `meta`-click. Flagged
  in the milestone spec.
- Full edge undo is deferred to the vision §Full undo milestone.
- Drop-in-empty leaves no orphaned visible state: a dangling edge (target un-placed by `⌘Z`)
  draws nothing on the canvas — the `canvasEdges` join returns no row for an un-placed endpoint.
- The connect-handle hover affordance requires a `getComputedStyle` call for first-edge geometry
  (filed as #136 — a known CSS-dependency in the gesture layer).
- Multi-select `ctrl`-deselect behaviour change tracked in #132.

## Sources

- `docs/specs/v0.4.1-canvas-edges.md` §3 (gesture), §4 (undo wrinkle), §7 (future contracts)
- `docs/plans/v0.4.1-canvas-edges.md` — Locked decisions 2, 3, 5
- Issue #132 (multi-select deselect — ctrl modifier change)
- Issue #136 (connect-handle hover + first-edge getComputedStyle)
- ADR 0031 (arrangements as commands — the layout-undo stack this ADR deliberately avoids)
