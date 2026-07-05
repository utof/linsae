# 0053 — Session persistence via the `app_settings` KV

Status: accepted (v0.7)

## Context

Through v0.6 every piece of UI/session state was ephemeral: the dock layout, the
focused note, the open thread, feed + thread scroll positions, unsent composer drafts,
and the PDF zoom all reset to defaults on each launch. The single persisted-UI precedent
was `pdf.openDocId` (`usePdfOpenId`, a lone `settings:get`/`settings:set` pair), so the
mechanism to persist UI already existed but had exactly one narrow consumer.

v0.7 dogfooding turned session reconstruction into a real per-restart tax: after every
restart you re-opened the thread you were reading, re-scrolled the feed to where you left
off, and re-typed the draft you had half-written. The state that made a session *yours*
had to be rebuilt by hand each time.

The storage layer was already there: an `app_settings(key, value)` KV table
(`src/main/db/queries/settings.ts`), JSON-encoded TEXT values, added in v0.5 for
`notes.recencyMode`. The question was not "where do we store it" but "how do we read it
at boot without a flash, default it safely, and write it back without thrashing."

## Decision

Reuse the existing SQLite `app_settings` KV for all v0.7 session state. Concretely:

- **One batched boot read.** `getManySettings(db, keys)`
  (`src/main/db/queries/settings.ts:34-38`) is a thin loop of single-key `getSetting`
  reads exposed over a new `settings:getMany` channel
  (`SettingsGetManyInputSchema`, `src/shared/zod-schemas.ts:413-415`, `keys.max(64)`).
  It collapses session restore into **one IPC round-trip** (not one SQL query — N
  single-key SQL reads server-side). The renderer reads it once via
  `useSessionSnapshot` (`src/renderer/src/persistence/useSessionSnapshot.ts`), a
  `@tanstack/react-query` query with `staleTime: Infinity` — read at boot, writers own
  updates thereafter.

- **Versioned keys + defensive parse.** Every key is suffixed `.v1`
  (`SETTING_KEYS`, `src/renderer/src/persistence/keys.ts:12-20`) and every value is run
  through a versioned Zod schema via `safeParseOr(schema, value, def)`
  (`src/shared/zod-schemas.ts:485-488`), which returns `def` on **any** parse failure.
  The seven persisted-value schemas are `DockLayoutV1Schema`, `UiSessionV1Schema`,
  `FeedScrollV1Schema`, `ThreadScrollV1Schema`, `ComposerDraftFeedV1Schema`,
  `ComposerDraftThreadV1Schema`, `PdfViewV1Schema` (`src/shared/zod-schemas.ts:500-541`).
  A schema change, a corrupt value, or a hand-edited DB degrades that one surface to its
  default instead of crashing the boot.

  Note the deliberate `z.partialRecord` (NOT `z.record`) for the enum-keyed dock side
  maps (`src/shared/zod-schemas.ts:494-499`): `z.record(z.enum(['left','right']), …)` is
  **exhaustive** in zod v4 — it requires BOTH keys, so the common `{}` / single-side
  widths would fail `safeParse` and `safeParseOr` would silently discard the *entire*
  dock layout. `partialRecord` accepts `{}` and `{right:5}` while still validating values.

- **FAIL-OPEN boot gate.** Restorable surfaces hold their first render until the snapshot
  has *settled*: `snapSettled = snap.isSuccess || snap.isError`
  (`src/renderer/src/App.tsx:125-126`). Gating on `isSuccess` alone would white-splash-hang
  the app forever if `settings:getMany` ever rejected. On error, `snap.data` is undefined
  and every consumer's `snap.data?.x ?? default` falls through to the no-restore path — a
  rejected read reveals a fresh app, never a hung one. The boot splash is held on the same
  gate (`App.tsx:580-587`); the dock hydrates once, marking `hydrated=true` even on error
  so the persist writer still arms (`App.tsx:596-600`).

- **Debounced write-through.** `usePersistedWrite(key, value, {debounceMs, enabled})`
  (`src/renderer/src/persistence/usePersistedWrite.ts`) writes back debounced, `enabled`
  on `snapSettled` (so the just-hydrated value isn't echoed straight back to disk), and
  skips its own initial value. `visibilitychange`→hidden is the authoritative last-chance
  flush of any pending write (the reliable hook in an Electron renderer;
  `beforeunload`/unmount async IPC is best-effort).

### Consumers seed from the boot-initial snapshot — the pdf-zoom liveness exception

The snapshot cache is **boot-initial only**: writers call `api.settings.set` but do not
update the `['session-snapshot']` query cache, so a re-read never reflects a later write
(`useSessionSnapshot.ts:15-24`). Every consumer therefore seeds *local* React state from
the snapshot once (render-phase or a one-shot effect) and owns it from there.

PDF zoom is the one architectural exception and is worth calling out. A within-session
document swap A→B→A must restore A's *current* zoom, not its stale boot value — so
`PdfReader` keeps the cache LIVE: on each zoom change it writes the new per-document view
map back into the query cache via `qc.setQueryData(['session-snapshot'], …)` *and*
schedules the debounced disk write (`src/renderer/src/pdf/PdfReader.tsx:98-110`). Because
`staleTime` is Infinity, `setQueryData` is a synchronous cache write with no refetch, so
the restore-on-swap effect (`PdfReader.tsx:84-86`, keyed on `doc`) always reads the latest
zoom. No other consumer needs cross-swap reads within one session, so no other consumer
re-writes the cache; pdf-zoom is the sole liveness case.

## Alternatives

- **zustand `persist` middleware with async storage.** Rejected: it write-thrashes on
  every store tick (no natural debounce for a scroll/zoom stream), it hydrates
  *asynchronously* so the first paint flashes the default before storage resolves — the
  opposite of the render-body seed + `snapSettled` gate this app needs for a flash-free
  restore — and its default behavior swallows parse errors rather than degrading to a
  typed default. We already have a synchronous SQLite read at boot; an async storage layer
  on top of it is a step backward.

- **Bespoke per-key ad-hoc `settings:get`/`settings:set` at each call site** (the
  `usePdfOpenId` shape, generalized by hand). Rejected: no single boot round-trip (N
  channels, N awaits, N flashes), and no uniform defaulting — each site would re-invent
  its own parse-or-default, exactly the drift `safeParseOr` + one versioned schema per key
  exists to prevent.

## Consequences

- **One mechanism, no migration.** The KV table already existed (v0.5), so v0.7 adds no
  schema/migration — only the `settings:getMany` read channel, the seven schemas, and the
  two renderer hooks.
- **`visibilitychange`→hidden is the authoritative flush; unmount is best-effort.**
  `usePersistedWrite` documents that an unmount or `enabled`→false *mid-debounce* drops the
  pending write (`usePersistedWrite.ts:8-9`); this never bites in practice because every
  v0.7 caller lives in the long-lived `App` and flushes on hidden.
- **The boot gate must stay FAIL-OPEN.** Any future restorable surface that gates its
  first render on the snapshot must gate on `snapSettled` (settled), never on
  `snap.isSuccess` — an IPC read failure has to reveal a no-restore app, not hang the
  splash.
- **`pdf.openDocId` fold deferred.** The spec folded `pdf.openDocId` into `getMany` for a
  single boot round-trip; v0.7 leaves `usePdfOpenId`'s separate `settings:get` unchanged
  and defers the fold — one extra small read, not worth the `App` surgery this milestone
  (`keys.ts:22-25`).

## Sources

- `src/main/db/queries/settings.ts:34-38` — `getManySettings` (batched boot read).
- `src/shared/zod-schemas.ts:413-415` — `SettingsGetManyInputSchema` (`keys.max(64)`).
- `src/shared/zod-schemas.ts:485-488` — `safeParseOr`.
- `src/shared/zod-schemas.ts:494-499` — the `z.partialRecord` (not `z.record`) rationale.
- `src/shared/zod-schemas.ts:500-541` — the seven `*V1` persisted-value schemas.
- `src/renderer/src/persistence/keys.ts` — `SETTING_KEYS`, `ALL_SESSION_KEYS`,
  `SessionSnapshot`; the deferred-`pdf.openDocId` note (lines 22-25).
- `src/renderer/src/persistence/useSessionSnapshot.ts` — `staleTime: Infinity`, Zod
  safe-parse, boot-initial-only cache.
- `src/renderer/src/persistence/usePersistedWrite.ts` — debounce + `visibilitychange`
  flush + unmount-mid-debounce caveat.
- `src/renderer/src/App.tsx:125-126` (`snapSettled` FAIL-OPEN gate), `:580-587` (splash),
  `:596-600` (dock hydrate-once).
- `src/renderer/src/pdf/PdfReader.tsx:84-86`, `:98-110` — the `setQueryData` liveness
  exception for cross-swap zoom restore.
- `adrs/0054-virtual-core-3.17-bump.md`, `adrs/0055-feed-scroll-restore.md` — the two
  scroll-restore surfaces that consume this mechanism.
