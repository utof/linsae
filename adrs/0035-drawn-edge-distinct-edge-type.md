# 0035 — Drawn edges use a distinct edge_type (not 'reference')

Status: accepted (v0.4.1)

## Context

Drawn edges are real `links` rows — the same table that stores wikilink-derived `'reference'`
edges and `'comment-on'` annotation edges. The trap: `replaceLinksForNote`
(`src/main/db/queries/links.ts:46`) executes `DELETE FROM links WHERE from_note_id = ? AND
edge_type = 'reference'` inside a transaction, then rebuilds only body-derived wikilinks. This
runs on **every note save** (`src/main/save-note.ts:228`), on soft-delete
(`src/main/save-note.ts:129`), on canvas create (`src/main/db/queries/layouts.ts:258`), and on
the reconciler (`src/main/db/reconcile.ts:150,163`). A drawn edge stored as `'reference'` would
be silently wiped on any of those paths — the trap the canvas vision flagged.

The PK of `links` is `(from_note_id, to_slug, edge_type)`, so `edge_type` is both the
discriminator and the label — it is already load-bearing, and any value NOT equal to `'reference'`
is untouched by `replaceLinksForNote`.

## Decision

A plain drawn edge uses the reserved sentinel `edge_type='link'`. A labeled edge uses the user's
free-text label verbatim (trimmed, non-empty). The values `'reference'` and `'comment-on'` are
**FORBIDDEN** as user-supplied edge labels, guarded at **two layers**:

1. **Zod boundary** (`src/shared/zod-schemas.ts:339` `EdgeTypeSchema`) — rejects reserved types
   on the IPC boundary before the main process is ever reached.
2. **Query wrapper** (`src/main/db/queries/edges.ts` `RESERVED_EDGE_TYPES`) — throws if a
   caller bypasses IPC and invokes `createDrawnEdge` or `deleteDrawnEdge` directly.

Defence in depth: either guard alone would suffice, but both must hold for the ADR to remain
valid. Any non-reserved `edge_type` is untouched by `replaceLinksForNote`, so drawn edges survive
saves.

## Alternatives

- **A separate `drawn_edges` table** — rejected. Would break the one-row-two-projections
  live-reference philosophy: `canvasEdges` (`src/main/db/queries/canvas-edges.ts`) reads all
  `links` rows whose endpoints are placed, so a separate table would require a UNION or a new IPC
  read path. Also contradicts `docs/specs/v0.4.1-canvas-edges.md` §1 decision to store drawn
  edges in `links`.
- **A boolean `is_drawn` column** — rejected. Requires a schema migration and adds a column that
  only duplicates what `edge_type` already expresses for free via the PK discriminator.

## Consequences

- Multiple distinctly-labeled edges between the same ordered pair coexist (PK is
  `(from_note_id, to_slug, edge_type)`); two plain `A→B` plain edges collapse (both `'link'`
  — intended: idempotent via `INSERT OR IGNORE`).
- The reserved-word guard is load-bearing — never relax it without also changing every call-site
  of `replaceLinksForNote` to scope its DELETE narrower.
- `tests/integration/canvas-edges.test.ts` ("drawn edge survives a save…") is the regression
  guard for the replaceLinksForNote–drawn-edge interaction.

## Sources

- `docs/specs/v0.4.1-canvas-edges.md` §1, §2, §7
- `src/main/db/queries/links.ts:46` — `replaceLinksForNote` (the DELETE scope)
- `src/main/save-note.ts:228` — call-site on note save
- `src/main/save-note.ts:129` — call-site on soft-delete
- `src/main/db/queries/layouts.ts:258` — call-site on canvas create
- `src/main/db/reconcile.ts:150,163` — call-sites in reconciler
- `src/main/db/queries/edges.ts` — `RESERVED_EDGE_TYPES`, `createDrawnEdge`, `deleteDrawnEdge`
- `src/shared/zod-schemas.ts:339` — `EdgeTypeSchema` (Zod boundary guard)
