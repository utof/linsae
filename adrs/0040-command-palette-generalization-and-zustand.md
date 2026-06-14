# 0040 — Command palette generalization (⌘K/⌘O/⌘P split) and first zustand store

Status: accepted (v0.5)

## Context

v0.4 had a single `⌘K` palette (`CommandPalette.tsx`) that combined two roles:
running app commands (New Note, Settings, etc.) and doing full-text content search
(FTS5 notes query). v0.5 needed to split these and add a third surface (title
quick-switcher), each backed by a different data source:

- **`⌘K` — commands**: run app actions and context-specific commands. These are
  registered at runtime (canvas commands appear when the canvas is active; note
  commands when a note is focused). The set is mutable and context-dependent —
  not a static list that can be compiled into a component prop.
- **`⌘O` — title quick-switcher**: search by note title (`notes:listTitles`,
  uncapped). Empty-state shows recency/frecency-sorted titles.
- **`⌘P` — content search**: the existing FTS5 BM25 full-text surface, rebounded
  from `⌘K`. Empty-state shows recent notes.

Two design questions arose:

1. **Where to store the command registry?** The registry needs to be readable by
   `CommandMenu.tsx` and writable by any component in the tree (canvas panel,
   focused-note toolbar, App-level base commands). Passing it down via props or
   context is possible, but every `register`/`unregister` call would cause a
   context re-render of all consumers — including `CommandMenu`, which builds the
   filtered list.
2. **How to coordinate one-open-at-a-time** across three palette components?

## Decision

**(a) `⌘K/⌘O/⌘P` scheme with `activePalette` in App local state.**
A single `useState<'none'|'command'|'title'|'content'>` in `App.tsx` (line 96)
is the coordinator. Opening any palette closes the others; hotkeys fire
`setActivePalette`. The three components (`CommandMenu`, `QuickSwitcher`,
`ContentSearch`) each receive `open: boolean` and `onClose: () => void`. This is
"small enough for local state" (spec §4 decision) — `activePalette` is ephemeral
UI state that lives and dies with App, has no persistence, and is not needed by
any other component tree. It is NOT in zustand.

**(b) zustand v5 for the command registry** (`src/renderer/src/palette/command-store.ts`).
The store holds a `Map<string, Command>` (registry), plus `register` / `unregister`
(O(1) by id, idempotent re-register replaces) and a snapshot accessor `commands()`.
Components call `useCommandStore((s) => s.registry)` and compute the display list
via `useMemo` on that selector — subscribed only to registry changes, not to the
whole store. This is the app's first and (for this milestone) only client-state
library.

`Command.run: () => void | Promise<void>` is deliberately sync-or-async-agnostic.
A future global-undo "Undo"/"Redo" command slots in without a registry schema
change: `run` just calls the undo manager.

Zustand `^5.0.14` added to `package.json`.

## Alternatives

- **React context for the registry** — rejected. Every `register` or `unregister`
  call produces a new context value, causing a re-render of every component that
  consumes the context (including `CommandMenu` and anything else that reads the
  registry). With zustand, `CommandMenu` subscribes to a stable selector
  (`s => s.registry`) and only re-renders when the Map reference actually changes
  (on each `register`/`unregister`). Context would be adequate for a static list;
  a mutable registry that changes on every navigation or modal open is the
  canonical zustand use-case.
- **Module-level mutable array (singleton)** — rejected. A module-level `let
  commands: Command[] = []` mutated directly has no reactivity — `CommandMenu`
  would not know when to re-render after a `register` call. It also cannot be
  reset between tests. zustand gives reactivity and a `reset()` method for test
  isolation at essentially no cost (`~700B` minzipped in tree-shaken form).
- **Folding `activePalette` into the zustand store** — considered and rejected per
  the spec decision (plan locked decision 8). Keeping the one-open coordinator in
  App local state preserves the boundary: zustand holds only the command registry
  (client UI state that outlives any single component but is not server state);
  react-query holds all DB state. Mixing ephemeral open/close UI state into the
  zustand store would blur that boundary with no benefit.
- **redux / jotai / valtio** — rejected on scope. The registry is a single `Map`;
  zustand is ~700B and already well-understood in the team's v0.1 research.
  Adding a second atom-model library (jotai/valtio) for a single use-case is
  unnecessary scope.

## Consequences

- **First client-state library** in linsae. The established pattern is: DB state
  → react-query (`['setting', key]`, `['notes']`, etc.); ephemeral UI state →
  component `useState`; genuinely mutable app-global client UI state (the command
  registry) → zustand. Future stores (if any) should follow this taxonomy rather
  than adding zustand for state that belongs in react-query or local state.
- **Command.run is agnostic**: async commands (e.g., ones that open dialogs and
  await a result) work without wrapping. This enables a future global-undo command
  with no registry change.
- **`activePalette` in App.tsx** centralizes the coordination *state* in a single
  `useState` (`App.tsx:96`): the three palette hotkeys are adjacent `useHotkeys`
  blocks (`App.tsx:372–399`) and the Escape rung dismisses whichever palette is
  open (`App.tsx:454–456`), all reading/writing the one `activePalette` — easy to
  audit and test.
- **Issue #143** (palette `#fff` literal — should be a CSS token) and **#144**
  (palette Dialog lacks an accessible title) are filed nits that do not block the
  milestone.
- **Issue #145** (palette transition animation tests) deferred to a follow-up.

## Sources

- `docs/specs/v0.5-command-search.md` §4 (command palette generalization), §11 (scheme)
- `src/renderer/src/palette/command-store.ts` — zustand store implementation
- `src/renderer/src/App.tsx:96` (state), `:372–399` (hotkeys), `:454–456` (esc rung), `:875–886` (palette render) — `activePalette` coordination
- `package.json` — `"zustand": "^5.0.14"`
- `https://zustand.docs.pmnd.rs/getting-started/introduction` — zustand v5 docs
- Issue #143 (palette #fff token), #144 (palette Dialog a11y title), #145 (palette transition tests)
