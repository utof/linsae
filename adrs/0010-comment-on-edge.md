# 0010 — Comment-on edge as data (not a parent column)

## Context
v0.2 introduces comment-notes: notes created in the context of a specific
video-note that appear as a threaded list in `ThreadView`. Each comment-note
needs a relationship back to its video-note. The obvious modelling option is a
`parent_note_id` column on `notes`. The research doc (§6.5) considered this and
rejected it in favour of reusing the existing `links` table.

The `links` table (introduced in `0001_init.sql`, frozen) already has an
`edge_type` discriminant (default `'reference'`) and a composite PK
`(from_note_id, to_slug, edge_type)`. A new `edge_type` value is additive: no
schema migration is needed, and the wikilink resolver (`replaceLinksForNote`)
already scopes its delete-then-insert to `edge_type = 'reference'`
(`src/main/db/queries/links.ts` line 48), so comment-on edges survive body
edits automatically.

## Decision
A comment-note relates to its video-note via a `links` row with
`edge_type = 'comment-on'`. No `parent_note_id` column is added to `notes`.

`setCommentOnEdge` (`src/main/db/queries/links.ts` line 153) inserts the row
idempotently via `INSERT OR IGNORE` using the composite PK. It is called once
at note-create time from `saveNote` (`src/main/save-note.ts` line 226) when
`input.commentOn` is set.

`replaceLinksForNote` (`links.ts` line 46) only deletes and re-inserts rows
with `edge_type = 'reference'` (line 48). Body edits re-derive only `'reference'`
edges; the `'comment-on'` edge is never touched by saves or reconciles.

The reader `commentsForVideo` (`links.ts` line 111) joins `notes` through
`links` filtered by `edge_type = 'comment-on' AND n.deleted_at IS NULL`, sorted
oldest-first so the thread renders chronologically. Each row is paired with a
correlated subquery for the note's latest live attachment.

The `links:commentsOf` IPC handler (`src/main/ipc/notes.ts` line 106) resolves
the caller's `noteId` → `slug` via `getNote`, then calls `commentsForVideo`.
This indirection is necessary because `commentsForVideo` matches on `to_slug`
(the video-note's slug), not its id.

## Alternatives
- **`parent_note_id` column on `notes`** — rejected. Irreversible single-parent
  commitment; couples the `notes` table to one thread shape; requires a
  migration of the frozen `0001_init.sql` (additive but semantically heavier).
  The `links` approach keeps `notes` flat and reuses the existing wikilink
  resolver as documented in research §6.5 "Why not `parent_note_id`".
- **Separate `thread_memberships` table** — rejected; over-engineered for one
  relationship type; the `links` table's `edge_type` discriminant is
  purpose-built for this.

## Consequences
- The `'comment-on'` edge-type joins the schema as a permanent value; future
  `edge_type` additions follow the same pattern (additive, zero migration cost).
- Soft-deleting a comment-note sets `deleted_at` on the note row; `commentsForVideo`
  filters `n.deleted_at IS NULL` so the edge row physically persists but is
  hidden at read-time. The soft-delete-dangling-edge question (a deleted comment
  still has a `links` row with a valid `from_note_id`) remains open as GH #36;
  the current behaviour is intentional — the `deleted_at IS NULL` guard is the
  single control point.
- `replaceLinksForNote`'s scope restriction to `'reference'` is load-bearing:
  any future caller that inadvertently widens the `DELETE` predicate to all
  edge-types would silently destroy thread membership.

## Sources
- `docs/research/2026-05-30-youtube-player.md` §6.5 — data model rationale.
- GH #36 — soft-delete dangling edge: https://github.com/utof/linsae/issues/36
- `src/main/db/migrations/0001_init.sql` — `links` table definition.
