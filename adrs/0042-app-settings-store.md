# 0042 — Generic app_settings store (SQLite, react-query)

Status: accepted (v0.5)

## Context

v0.5 introduced a user-facing toggle between recency and frecency sort order in
the `⌘O`/`⌘P` empty-state. This is the first persistent preference in linsae that
is not a note body or a spatial layout — it is a plain key/value user setting that
must survive app restarts and vault moves together with the rest of the DB.

The spec also noted that #129 (slug alias/rename propagation) will need a
"propagate on rename" toggle, and possibly other future milestones will need
similar scalar preferences. The question was: design a single-use settings
mechanism for `notes.recencyMode` only, or design a generic key/value store that
future preferences can reuse verbatim?

## Decision

**A generic `app_settings(key TEXT PRIMARY KEY, value TEXT NOT NULL)` table in
the SQLite DB, exposed via react-query (`['setting', key]`), with a
`useSetting(key, default)` hook.**

Migration `0005_app_settings.sql`:
```sql
CREATE TABLE app_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

Main-process queries in `src/main/db/queries/settings.ts`:
- `getSetting(db, key)` — `SELECT value … WHERE key = ?`, JSON-parse, return
  `unknown | null` (null when the key is absent).
- `setSetting(db, key, value)` — `INSERT … ON CONFLICT(key) DO UPDATE SET value
  = excluded.value` (upsert; value is `JSON.stringify`'d).

Renderer hook in `src/renderer/src/lib/use-setting.ts`:
- `useSetting<T>(key, def: T): T` — react-query `queryKey: ['setting', key]`;
  returns `def` while loading AND when the key is absent (absence-default is the
  caller's concern, not a DB row).
- `useSetSetting(key)` — `useMutation` + `invalidateQueries(['setting', key])`.

IPC channels: `settings:get(key) → { value: unknown | null }` and
`settings:set(key, value) → void`, validated with Zod at the boundary.

First consumer: `notes.recencyMode` toggle in `SettingsPanel.tsx`.
Planned reuse: #129's `rename.propagateOnRename` toggle.

## Alternatives

- **localStorage** — rejected. The renderer's `localStorage` is not readable by
  the main process. More importantly, it does not travel with the vault: if the
  user moves the vault directory (or opens it on a different machine), localStorage
  is left behind. All persistent app state in linsae lives in the SQLite DB
  alongside the notes; settings must follow the same rule.
- **A single-use `notes.recencyMode TEXT` column on the `notes` table or as a top-level
  constant** — rejected on scope grounds. A scalar column on `notes` makes no
  conceptual sense (it is per-vault, not per-note). Hardcoding a constant means
  the toggle has no persistence. A generic settings table costs one migration and
  ~40 lines; the payoff is that every future preference reuses the same IPC pair
  and hook without a new migration.
- **electron-store / a JSON config file** — rejected. Adds a new dependency and a
  new file format alongside the existing SQLite DB. The `main` process can already
  read the DB synchronously; a second persistence layer adds complexity and creates
  a divergence risk (what if DB and config file disagree?).
- **A zustand settings store** — rejected. Settings are server/DB state (they
  persist in SQLite, are fetched over IPC, and must be invalidated when updated).
  react-query is the established pattern for all DB state in linsae; zustand is
  scoped to client UI state that does not round-trip to the DB (ADR 0040).

## Consequences

- **Reusable by any future setting**: any key/value preference that is JSON-
  serialisable fits the schema. #129's `rename.propagateOnRename` is already
  calling the same `useSetting`/`useSetSetting` pair without a new migration.
- **Absence-default in the hook layer, not a DB row**: `useSetting('notes.recencyMode', 'frecent')`
  returns `'frecent'` when the key is unset (fresh vault). No `DEFAULT` in the
  schema means a fresh install has zero rows in `app_settings`, which is clean.
- **react-query cache key per setting**: `['setting', key]` means each setting is
  a separate cache entry and invalidation is surgical — toggling
  `notes.recencyMode` does not cause a global re-fetch.
- **No Zod schema for the value type**: the `value: unknown` return type keeps the
  generic layer flexible; callers narrow the type via the `T` parameter of
  `useSetting<T>`. A corrupt value (non-JSON string) would throw in `JSON.parse`
  and surface as an IPC error — this is intentional (we want to surface data
  corruption, not swallow it silently with a default).

## Sources

- `docs/specs/v0.5-command-search.md` §1.3 (settings store), §8 (useSetting hook)
- `src/main/db/migrations/0005_app_settings.sql` — table DDL
- `src/main/db/queries/settings.ts` — `getSetting`, `setSetting`
- `src/renderer/src/lib/use-setting.ts` — `useSetting`, `useSetSetting`
- Issue #129 (rename propagation — planned first reuse of this settings store)
- ADR 0040 (zustand for client UI state — why settings are NOT in zustand)
