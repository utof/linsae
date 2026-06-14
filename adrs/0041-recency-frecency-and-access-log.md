# 0041 — Recency/frecency empty-state and note_access log

Status: accepted (v0.5)

## Context

The v0.5 quick-switcher (`⌘O`) and content-search (`⌘P`) surfaces need an
empty-state: when the user opens the palette before typing anything, what should
they see? The spec called for a recency or frecency-sorted list of notes that the
user has recently interacted with.

Three design questions arose:

1. **Where to store access events?** The app's source of truth is the SQLite DB
   (markdown bodies on disk + metadata in `notes`, spatial data in
   `node_layouts`/`links`). Storing access history in a renderer side-channel
   (localStorage, an in-memory ring) would not survive a vault move or an app
   restart, and the main process could not read it.
2. **Frecency algorithm?** Pure recency (last-touched first) degrades for users
   with large corpora: a note touched yesterday but visited fifty times ranks
   lower than a note touched 10 minutes ago for the first time. The zoxide
   CLI tool has a well-known, battle-tested two-factor model (frequency ×
   recency-bucket multiplier) that fits this use-case exactly.
3. **Where to compute the frecency rank?** The zoxide step-function buckets
   (`<1h ×4 / <1d ×2 / <1w ×0.5 / else ×0.25`) and the future aging compaction
   rule do not express cleanly in SQLite `CASE` expressions, and cannot be unit-
   tested in isolation in SQL. A pure JS function can be tested with fixtures
   in isolation (same pattern as `fuzzy.ts` in ADR 0037).

## Decision

**(a) DB-only `note_access` table** (`src/main/db/migrations/0006_note_access.sql`):
```sql
CREATE TABLE note_access (
  note_id          TEXT    PRIMARY KEY REFERENCES notes(id) ON DELETE CASCADE,
  last_accessed_at INTEGER NOT NULL,
  frequency        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_note_access_recency ON note_access(last_accessed_at);
```
Not reconciled with the markdown filesystem (purely app state, like `node_layouts`
and `links`). `ON DELETE CASCADE` drops the row when the note is hard-deleted.

**(b) Zoxide-style frecency computed in main-process JS** via the pure
`frecencyScore(frequency, lastAccessed, now)` function in
`src/main/db/queries/recency.ts:25–29`:
```
age < 1h  → frequency × 4
age < 1d  → frequency × 2
age < 1w  → frequency × 0.5
else      → frequency × 0.25
```
`recentNotes` fetches a bounded candidate set (all `note_access` rows up to
`5 × limit` cap, recency-ordered) + a backfill of never-accessed notes so the
empty-state is never sparse. The JS sort then re-ranks by `frecencyScore` for
`mode='frecent'` or by `last_accessed_at` for `mode='recent'`.

**(c) Default mode: `frecent`.** The absence-default in `useSetting('notes.recencyMode', 'frecent')`
means a vault with no access history at all behaves as if frecency is on (which
degrades gracefully to recency-order because frequency=0 × any-multiplier = 0,
so the backfill list is used).

**(d) Access instrumented at three verbs:** `openThread` (open a note in the
feed, `App.tsx`), `save-note.ts` (edit = any save with a user-initiated body
change), and `onJumpToCard`/`onSwitcherJump` (jump = ⌘O or ⌘K navigation). All
call `notes:recordAccess` over IPC, which upserts into `note_access`.

**(e) `listTitles` is uncapped.** The quick-switcher fuzzy search needs all live
note titles, not just the recent cap, so `notes:listTitles` returns all live notes
ordered by `created_at DESC` with no `LIMIT`. This is consistent with #130 
(the pre-v0.5 cap fix) and closes the "partial corpus" bug in `⌘K`.

## Alternatives

- **localStorage or in-memory ring** — rejected. Not readable by the main process
  (IPC cannot reach localStorage; renderer memory is lost on restart). Does not
  survive a vault move. The DB is the single source of truth for all persistent
  app state.
- **Frecency in SQL CASE** — rejected. The 4-way step-function is expressible in
  SQLite but requires embedding `now` as a parameter in a complex `CASE` expression
  that is hard to read and impossible to unit-test in isolation. The aging
  compaction rule (Σfrequency cap × 0.9 decay) would require a stored procedure
  equivalent that SQLite does not support. A pure JS function (`frecencyScore`)
  is four lines and is unit-tested directly with fixtures in
  `src/main/db/queries/recency.test.ts`.
- **A separate "recent notes" IPC channel (no frecency)** — rejected. Spec §7
  explicitly calls for a toggleable recency/frecency mode (exposed as the
  `notes.recencyMode` setting). Pure recency degrades for power users with large
  corpora where older frequently-accessed notes fall out of the recent window.
- **Aging compaction in v0.5** — deferred. The zoxide model's aging step
  (multiply all frequencies by 0.9 and drop sub-1 rows when `Σfrequency > cap`)
  bounds frequency growth over months of use. The v0.5 ranking is correct without
  it (only the long-run growth bound is missing). Aging compaction is deferred to
  a follow-up; the schema and the scorer are already shaped for it.

## Consequences

- **No reconciler entry**: `note_access` is like `node_layouts` — DB-only state
  that is not reflected in the markdown files and is not re-derived on reconcile.
  An `IMPORT` or vault switch drops the rows. Accepted: access history is
  app-context-specific.
- **Bounded candidate set approximation**: `recentNotes` caps the SQL candidate at
  `5 × limit` (recency-ordered), then JS-sorts by frecency. A very-high-frequency
  but old note can fall outside the top-`5×limit` recency window before the sort —
  a deliberate approximation documented in the plan. For vaults with < a few
  hundred accessed notes this is never triggered.
- **Aging compaction deferred**: `frequency` will grow unboundedly for long-lived
  notes. The scorer remains correct (relative ordering is not affected), but the
  integers will grow large over months. Filed for a follow-up once usage data
  motivates setting the compaction threshold.
- **Pure `frecencyScore` is unit-tested** (same pattern as `fuzzy.ts`, ADR 0037):
  isolated, deterministic fixtures in `src/main/db/queries/recency.test.ts` give
  confidence in the bucket boundaries without needing a running DB.

## Sources

- `docs/specs/v0.5-command-search.md` §3 (listTitles uncap), §7 (frecency model)
- `src/main/db/migrations/0006_note_access.sql` — table + recency index
- `src/main/db/queries/recency.ts` — `frecencyScore`, `recordAccess`, `recentNotes`, `listTitles`
- `https://github.com/ajeetdsouza/zoxide/wiki/Algorithm` — zoxide frecency buckets
- ADR 0037 (hand-rolled subsequence fuzzy — the `fuzzy.ts` isolation precedent)
