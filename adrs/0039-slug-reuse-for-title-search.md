# 0039 — Slug reuse for FTS title-weighting; no persisted title column

Status: accepted (v0.5)

## Context

v0.5 adds a quick-switcher (`⌘O`) that must search by note title and rank title
matches above body matches in full-text content search (`⌘P`). The question was
how to index and display note titles without adding a dedicated column.

Notes in linsae do not carry a `title` column. Titles are the first meaningful
line of the markdown body (a heading or plain first line). At v0.1 the renderer
derived the display title inline with its own regex; `save-note.ts` derives the
slug from the same line via `slugFromBody`. By v0.4 the renderer's per-row strip
logic (`noteTitle`) and the slug derivation were parallel paths over the same line
— identical heading parse, but different downstream treatment (one lowercases +
collapses for identity; the other strips inline markdown for display).

v0.5 needed:

1. **FTS title-weighting** — the `⌘P` content search should surface title-word
   hits above body-only hits (`bm25` with a higher weight for the title column).
2. **Display titles everywhere** — the quick-switcher, `notes:listTitles`, and
   FTS hit rows all need a renderable title string without a DB `SELECT title`.
3. **A single parse** — duplicating the title-extraction regex across main and
   renderer risked silent drift (a heading in one parsed differently in the other
   would give different slugs and display titles for the same body).

Alternatives considered for the FTS title column:
- Add a persisted `title TEXT` column to `notes`, backfill on migration, keep it
  in sync via the `AFTER UPDATE` trigger.
- Add a virtual (computed) SQLite column deriving the title from the body.

## Decision

**Reuse the existing `slug` column for FTS title-weighting; derive the display
title on read; shared extraction in `src/shared/note-title.ts`.**

Three concrete sub-decisions:

**(a) No new `notes` column.** The `slug` column is already written on every save
(`save-note.ts`) and it already encodes the first meaningful line (lower-cased,
whitespace-collapsed). Adding `slug` to the FTS virtual table gives bm25 a
"title column" for free — migration `0004_fts_slug_prefix.sql` drops and
recreates `notes_fts(slug, body, content='notes', prefix='2 3')` with three
triggers + a `'rebuild'` so no rows are lost. `bm25(notes_fts, 10.0, 1.0)` then
weights slug-column hits 10× body-column hits (spec §1.1 / §6).

**(b) Display title derived on read.** `deriveTitle(body)` strips inline markdown
(list/quote markers, wikilinks, images, emphasis, code, task boxes), clamps to 80
code points, and returns `''` when nothing renderable remains. Callers fall back
to the slug: `deriveTitle(r.body) || r.slug`. This pattern appears in
`src/main/db/queries/search.ts:117`, `src/main/db/queries/recency.ts:71/88/99`,
and the renderer's `src/renderer/src/lib/note-title.ts:14` (`noteTitle`).
No persisted `title` means no migration debt, no trigger drift, no backfill risk.

**(c) Shared extraction in `src/shared/`.** `src/shared/note-title.ts` exports
`titleLine(body)` (first non-empty line, `#+\s*` heading marker stripped) and
`deriveTitle(body)` (display strip + clamp). `slugFromBody` in
`src/main/text/slug.ts` becomes `normalizeSlug(titleLine(body))` — it now shares
the heading-strip with `deriveTitle`, so slug and display title can never diverge
on what they consider the "title line". `src/renderer/src/lib/note-title.ts`
re-exports `noteTitle(note)` = `deriveTitle(note.body) || note.slug`, delegating
to the shared module.

## Alternatives

- **Persisted `title TEXT` column** — rejected. Requires a backfill migration (all
  existing `notes` rows), a new trigger arm, and creates a drift surface: if the
  derivation logic ever changes, stored titles and derived titles diverge until a
  re-migration. The slug is already written on every save and captures the same
  raw heading line, so it already serves as a free FTS title column without any of
  these costs.
- **SQLite generated (virtual) column** — rejected. SQLite does not support
  full-text string operations (regex) in generated column expressions, so the
  derivation would be limited to simple substring extraction and could not strip
  markdown syntax. The heading strip (`^#+\s*`) alone is a regex that SQLite
  cannot express in a generated column.
- **No shared module; keep parallel extraction** — rejected. The v0.4 arrangement
  (renderer regex + `slugFromBody` in main) diverged subtly from each other for
  blockquote-prefixed or malformed headings. A shared `titleLine` is the only way
  to guarantee that slug identity and display title parse the same byte sequence.

## Consequences

- **FTS title-weighting works without schema growth**: `bm25(notes_fts, 10.0, 1.0)`
  delivers the spec §1.1 guarantee with no new `notes` column.
- **Slug as FTS title column**: the slug is lower-cased and has whitespace collapsed
  (`normalizeSlug`), which means FTS matches on the slug are case-folded. This is
  intentional and consistent with the existing wikilink resolution semantics.
- **Frozen-slug staleness (deferred to #129)**: the slug is frozen on the note's
  last edit — editing a note's body line changes the slug only when `save-note.ts`
  writes the row. Between edits the slug (and therefore the FTS title weight) may
  lag the live heading. The *displayed* title (`deriveTitle`) is always computed
  from the current body and therefore always live; only the FTS *weight* follows
  the frozen slug. Fixing this (slug-on-rename propagation) is scoped to #129 and
  the suggested next milestone.
- **Display-title edge change (issue #141)**: the unified `titleLine` pattern
  (`^#+\s*`) changed how malformed or blockquote-prefixed headings render vs.
  the old renderer-local regex. Slug identity is byte-identical to pre-v0.5
  (same parse), but some display titles differ for unusual bodies. Filed as #141;
  accepted as a display-only edge case.
- **Intra-word punctuation FTS recall gap (issue #142)**: the punctuation strip in
  `buildMatch` (`src/main/db/queries/search.ts:48`, `/[^\p{L}\p{N}]/gu`) means a
  query like `C++` is indexed/searched as `C`, a known recall gap that drops hits
  containing only `C++`. The gap is real but NOT yet inline-documented in the code;
  it is tracked (alongside a separate weight-test-comment accuracy nit in
  `tests/integration/fts-slug-search.test.ts`) by issue #142.
- **Prefix index**: `prefix='2 3'` in `notes_fts` gives prefix-query support for
  2- and 3-character prefixes, enabling fast search-as-you-type without a full
  scan. `buildMatch` appends `*` to the last token only (spec §6 decision).

## Sources

- `docs/specs/v0.5-command-search.md` §2 (slug reuse decision 7), §6 (bm25 weights)
- `src/shared/note-title.ts` — `titleLine`, `deriveTitle`
- `src/main/text/slug.ts` — `slugFromBody = normalizeSlug(titleLine(body))`
- `src/main/db/migrations/0004_fts_slug_prefix.sql` — FTS recreate + triggers
- `src/main/db/queries/search.ts` — `bm25(notes_fts, 10.0, 1.0)`, `buildMatch`, `deriveTitle(r.body)||r.slug`
- `https://www.sqlite.org/fts5.html#external_content_tables` — external-content FTS5 docs
- Issue #129 (slug rename propagation — the frozen-slug fix)
- Issue #141 (deriveTitle display-title edge change)
- Issue #142 (intra-word punctuation FTS recall gap)
