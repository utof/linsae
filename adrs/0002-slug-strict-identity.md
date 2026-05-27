# ADR 0002 — Slug uniqueness is a strict identity, not a most-recent-wins nickname

**Date:** 2026-05-27.
**Status:** accepted (v0.1.1).
**Reassessment trigger:** the next time a user reports friction from `[[abc]]`-rename pain in daily use, OR the first time spec §Resolution rule's step 5 (most-recent-wins for alias collisions) feels arbitrarily asymmetric to the slug path.

## Context

During v0.1.1 polish a `pnpm dev` startup crash surfaced: two on-disk notes whose first lines yielded the same slug (`slugFromBody("abc") → "abc"`) collided against `idx_notes_slug_live` (the partial unique index over live slugs), and the unhandled `SqliteError: UNIQUE constraint failed: notes.slug` aborted the entire reconcile transaction. The renderer never opened.

The same root cause produced a silent failure in the composer: typing `abc` and hitting Enter a second time threw the same constraint violation, the IPC call rejected, and the renderer swallowed the error without any UI feedback. The user kept typing `abc` over and over expecting it to save.

Two questions surfaced from this:

1. **What should happen when a user attempts to create a second note whose slug already exists?**
2. **Should slugs be a strict identifier (one note per slug at a time), or a nickname (many notes per slug, resolver picks the newest)?**

The spec was re-read carefully during the design discussion. §Resolution rule step 2 says: *"Match the **unique non-deleted note** whose `slug` equals normalized `target`"* — the slug-match path explicitly assumes uniqueness. The most-recent-wins rule (step 5) is scoped to **alias** collisions, not slug collisions. So the spec already treats slugs as identifiers; the schema's partial unique index enforces it; the bug is purely that the constraint violation was never surfaced to the user.

## Decision

**Slugs are strict identifiers.** At any moment, at most one live note may carry a given slug. The new code path:

1. `saveNote` in create-mode runs a `SELECT 1 FROM notes WHERE slug = ? AND deleted_at IS NULL` pre-check before any disk or DB write. On collision it throws `new Error('a note named "<slug>" already exists')` — a user-facing message — without touching disk or DB.
2. The Composer renders the error inline: red border (`--status-wtf`), `role="alert"` message below the textarea, and the body text + cursor are preserved. Next keystroke clears the error via `onClearError`.
3. The reconciler wraps each per-file INSERT in a nested `db.transaction()` (SAVEPOINT) with try/catch. UNIQUE-constraint failures are counted as `skipped` and logged to `reconcile.log` — same path as malformed frontmatter. Sibling files import normally; the bad file stays on disk untouched.
4. Soft-deleted notes don't block re-use of their slug — the partial unique index is `WHERE deleted_at IS NULL`, so a soft-delete followed by a same-slug create works. A test pins this so future refactors don't regress it.

Update-mode is unchanged: slugs are stable per spec §Stable slug from frontmatter, so editing a note's first line does NOT change its slug, and update cannot collide.

## Alternatives

- **Option A — auto-suffix on collision (`abc`, `abc-2`, `abc-3`).** Rejected: `[[abc]]` would only resolve to the first note; the second would become un-wikilinkable. Worse than the status quo.
- **Option C — drop the partial unique index, let the resolver pick the newest via the spec §Resolution rule step 5 mechanism.** Rejected: contradicts spec §Resolution rule step 2 (slug match expects uniqueness) and breaks the wikilink mental model — a `[[abc]]` written last week pointing to Note A could silently retarget to a newer Note B today.

## Consequences

**Positive:**
- `pnpm dev` no longer crashes on dup-slug disk state at startup.
- Spec §Resolution rule step 2 stays valid; no schema migration needed.
- Slug-as-identity is the model behind the wikilink resolver's whole step-2 path; treating it that way at the create boundary keeps the system coherent end-to-end.
- The composer's UX papercut (silent failure on second `abc`) is now a clear inline error — no Slack-style "what happened?" loop.

**Negative / risks:**
- Users who genuinely want to write `abc` twice (a Telegram-style "repeat yourself" message) must rename the first line. This is the friction the reassessment trigger watches for.
- The wikilinks resolver still inherits asymmetry: slug collisions are blocked at the create boundary, but alias collisions are tolerated and resolved by recency (spec §Resolution rule step 5). If this asymmetry feels arbitrary later, ADR-3 may unify them.

## Sources

- Design issue: https://github.com/utof/linsae/issues/23 (slug uniqueness — strict identity vs most-recent-wins nicknames)
- Spec §Resolution rule: `docs/specs/v0.1-rolling-feed-and-search.md:212-219`
- Schema: `src/main/db/migrations/0001_init.sql:16` (`CREATE UNIQUE INDEX idx_notes_slug_live ON notes(slug) WHERE deleted_at IS NULL`)
- Implementation commits (branch `phase/v0.1.1-polish`):
  - `8753fed` fix(reconcile): savepoint per-file so dup-slug INSERT doesn't crash startup
  - `157e4df` feat(save-note): pre-check slug uniqueness before file write
  - `c4ca1ce` feat(composer): inline error UI + body preservation on failed submit
