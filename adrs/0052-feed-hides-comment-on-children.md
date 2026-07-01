# 0052 — Feed hides `comment-on` children; canvas pickers stay unfiltered

Status: accepted (v0.6.4)

## Context

The v0.1 feed model is a **global chronological stream of everything**: every note row,
regardless of kind or relationship, appears in the rolling feed. This was the correct
default when all notes were top-level — before threads existed.

v0.6.4 makes every note a thread root (ADR 0051) and creates `comment-on` children
for PDF excerpts, plain thread replies, and YouTube annotations. On a typical annotating
session this generates dozens of child notes per document. Under the v0.1 "everything"
model, all of those children surface in the main feed — interleaved with unrelated
notes, mixed with the document cards they were created under. In user testing this is
experienced as noise: the feed becomes a confusing mix of contexts.

Simultaneously, canvas pickers (`EdgeTargetPicker`, `Picker` / ⌘O, content search) must
*not* filter these children. A PDF excerpt placed on the canvas must remain connectable
via an edge drag; a comment-on child note must remain searchable and navigable.
Filtering all consumers via a shared `notes:list` IPC path would unify the behavior but
regress the canvas use case.

The question: where does the filter apply, and how is it scoped?

## Decision

**The main feed hides any note that is the `from_note_id` of a `comment-on` link —
feed-scope only, opt-in flag, distinct query key.**

The feed query issues `notes:list` with a new `excludeThreadChildren: true` flag. The
main-process handler applies an anti-join against `links WHERE edge_type='comment-on'`:

```sql
SELECT n.* FROM notes n
WHERE NOT EXISTS (
  SELECT 1 FROM links l
  WHERE l.from_note_id = n.id
    AND l.edge_type = 'comment-on'
)
ORDER BY n.created_at DESC
```

This query runs under the react-query key `['notes', 'feed']` — a **distinct key from
`['notes', 'list']`**, which all canvas pickers, content search, and ⌘O use unchanged.
The flag is an implementation detail of the feed query; no other consumer sees or sets
it.

### Scoping rules (invariants)

| Consumer | `excludeThreadChildren` | Rationale |
|---|---|---|
| Main feed (`Feed.tsx`) | `true` | Noise reduction — the stated goal |
| Canvas `EdgeTargetPicker` | `false` (default) | Must find placed excerpt nodes |
| ⌘O quick-switcher | `false` (default) | Must navigate to any note |
| `⌘P` content search | `false` (default) | Must search across all notes |
| Thread `commentsForNote` | n/a (separate IPC) | Already scoped to one root |
| Search / FTS | n/a (separate channel) | Already unfiltered |

**Threads are unaffected.** `commentsForNote(slug)` is a separate IPC channel that
returns children of a specific root; it is not filtered.

**Search is unaffected.** FTS and the content-search palette query via `notes:search`,
a distinct IPC channel. Thread children remain fully searchable.

This is a **product model revision**, not a cleanup. The v0.1 "everything in the feed"
contract no longer holds after v0.6.4. This ADR records the change explicitly so it
is not silently reverted in a future milestone.

## Alternatives

- **Filter at the shared `notes:list` IPC handler for ALL consumers** — rejected.
  Canvas edge creation relies on `EdgeTargetPicker` finding every note, including placed
  excerpts that are `comment-on` children of a document note. Filtering at the shared
  handler regressed this in a pre-landing test: placed excerpts became un-connectable
  via ctrl-drag, because the picker could not find them. The opt-in flag with a distinct
  query key isolates the filter to the feed alone.

- **A `is_thread_child` boolean column on `notes`** — considered. A denormalized flag
  would make the anti-join a single-index scan instead of an anti-join subquery.
  Rejected: it is a derived value (computable from `links`), so writing it requires
  keeping the column in sync across `links` inserts and deletes. The anti-join subquery
  is fast enough for the feed's page-size queries and adds no schema surface to
  maintain.

- **Render thread children in the feed but group them under their parent** — considered
  as a UX alternative. Rejected in the v0.6.4 spec session (user decision): grouping
  adds significant UI complexity (collapsible groups, parent-card inline expansion) and
  the threading affordance — opening the thread view — already provides the grouped
  rendering. The feed should be signal, not noise.

## Consequences

- **Revises the v0.1 "everything in the feed" model.** Thread children, PDF excerpts,
  and YouTube annotations are feed-invisible. They live in threads and the canvas.
  `docs/specs/v0.1-rolling-feed-and-search.md` §User-facing surfaces is the
  authoritative record of the original model; this ADR is the revision record.
- **Canvas pickers, search, and ⌘O are unaffected.** All three continue to see the
  full note set. A placed PDF excerpt remains connectable, searchable, and navigable.
- **Feed query cache is isolated.** `['notes', 'feed']` and `['notes', 'list']` are
  separate react-query cache entries; mutations (create/delete/edit) must invalidate
  both. Any future mutation path that invalidates only one key will produce a stale
  feed or stale picker — treat this as a correctness invariant.
- **Known open item:** a canvas placeholder warmth first-paint flash occurs on the
  initial feed render in some cases (issue #170). Unrelated to this filter decision;
  tracked separately.

## Sources

- Commit `4b853f9` — "hide comment-on children from the feed only, not canvas pickers (#165)"
- Issue #170 — canvas placeholder first-paint flash (minor; unrelated)
- `docs/specs/v0.1-rolling-feed-and-search.md` §User-facing surfaces — original model
  this decision revises
- `adrs/0051-generic-comment-on-thread.md` — the thread primitive this scoping protects
