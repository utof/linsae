# 0036 — Drawn edges target a slug (dangle-on-rename), not a note id

Status: accepted (v0.4.1)

## Context

`links` stores `(from_note_id, to_slug, edge_type)` — the target is identified by the note's
current slug, not its stable UUID. This is the same shape as wikilinks: a `[[wikilink]]` targets
a slug, and if the target is renamed the link dangles (resolves to nothing) until rename-handling
propagates the change.

When a drawn edge is created, `createDrawnEdge` (`src/main/db/queries/edges.ts`) resolves
`toNoteId` → `to_slug` at insert time. Thereafter the row stores the slug, not the id.
Renaming the target leaves the `to_slug` stale: `canvasEdges`
(`src/main/db/queries/canvas-edges.ts:23`) joins on `notes.slug = lk.to_slug` — a stale slug
produces no match, so the edge disappears from the canvas without an error.

The question is whether drawn edges should store `to_slug` (consistent with wikilinks, but
dangle-on-rename) or `to_note_id` (no dangle, but a different reference model from wikilinks).

## Decision

Store `to_slug` — slug-based, uniform with wikilinks. No schema change; no new FK column.
A dangling drawn edge is invisible (the `canvasEdges` join returns no row), so it is never a
visible orphan. It is cleaned up naturally when rename-handling (#129/#98) lands and updates
all slug-based references uniformly.

## Alternatives

- **A `to_note_id` FK column** — rejected. It would NOT dangle on rename, but it creates two
  reference models in the codebase: wikilinks dangle by slug, drawn edges would not. The planned
  rename-handling effort (#129/#98) fixes ALL reference kinds uniformly — if drawn edges store an
  id, rename-handling would have to grow a separate code path for them. A single slug-based
  reference model is simpler and consistent; rename-handling is the right place to fix ALL of them
  at once.
- **Eager rename-propagation now** — rejected. Out of scope for this milestone; tracked as #129.

## Consequences

- Drawn edges dangle-on-rename like wikilinks; the dangle is invisible on the canvas (the edge
  simply doesn't render). Deferred to rename-handling #129/#98.
- The soft-delete orphan posture is deliberate: when the target note is soft-deleted, the stale
  slug again produces no `canvasEdges` match — the edge disappears. This is the consistent
  choice (vs. the `node_layouts` row cleanup that happens on hard-delete). The dangling links row
  persists in the DB harmlessly and is cleaned up when the rename/restore path handles it.
- Any future note-id-based reference feature must be careful NOT to assume `to_slug` and
  `to_note_id` are always equivalent — this ADR is the named reminder.

## Sources

- `docs/specs/v0.4.1-canvas-edges.md` §1 (decision 4), §7 (future contracts)
- `src/main/db/queries/edges.ts` — `createDrawnEdge` (slug resolution at insert)
- `src/main/db/queries/canvas-edges.ts:23` — `canvasEdges` (slug join — dangling slugs return nothing)
- Issues #129 (rename propagation), #98 (alias resolution)
- ADR 0002 (slug-strict identity — the slug-as-PK philosophy drawn edges inherit)
