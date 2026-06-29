# 0045 — Dock as ordered-panes + active-tab, zustand-backed, in-memory

Status: accepted (v0.6.2)

## Context

The v0.4 shelf and v0.6 PDF slim-slice each introduced a single-pane dock controlled
by ad-hoc booleans scattered across `App.tsx` (`dockOpen` for the shelf, `pdfPaneOpen`
derived from the persisted pdf id). That model
worked while each dock held exactly one thing: you either had it or you did not. The
forcing function for this milestone was **promoting backlinks to a dockable utility pane
so the right dock can hold both a PDF reader and a backlinks sidebar as peer tabs**. Two
panes sharing a dock cannot be modelled by a boolean.

The canvas vision (§Dock shell, principle 7) establishes the constrained-tiling grammar:
left dock / center stage / right dock, with tab strips that appear conditionally — *"tabs
as text labels … a user who never opens a second pane never sees a tab."* That
pay-as-you-go chrome rule means the data model must track an ordered list of open panes
plus which one is currently visible, not just a presence/absence flag.

Width management was a second pressure point. The v0.6 PDF pane needed a wider 400–900 px
band; the utility sidebar (shelf, backlinks) targets 220–400 px. Those bounds had been
copied inline into the component that used them. With two panes sharing a right dock and
the possibility of more panes in future milestones, a single authoritative source was
needed.

The question: where does the dock's ordered-pane list, active tab, and remembered-width
live, and what is its scope?

## Decision

**Each dock is a `{ openPaneIds: string[], activeId: string | null }` slice, held in a
zustand store (`dockStore.ts`), scoped to the current window session (in-memory, no
persistence).**

### Shape

```
DockSlice = { openPaneIds: string[], activeId: string | null }
DockStore  = { left: DockSlice, right: DockSlice, widths: Record<string, number>,
               openPane, closePane, togglePane, setActive, setWidth, reset }
```

Two docks (`left`, `right`) sit in a single store so cross-dock queries (e.g., "is the
backlinks pane open anywhere?") need no coordination between stores.

### Home-dock routing

Each pane in the `PANES` registry (`src/renderer/src/panes/Pane.tsx`) declares a
`homeDock: 'left' | 'right'` field. `openPane(id)` reads `getPane(id).homeDock` to
decide which slice to mutate. No call site needs to know or pass the side.

### Width bands: single source

`dock-widths.ts` is the **sole** source of the kind-band constants:

```
utility: { min: 220, max: 400, default: 280 }
content: { min: 400, max: 900, default: 600 }
```

The store's `setWidth` clamps via `clampWidth(kindOf(paneId), width)` before writing.
`DockHost` reads `dockWidthFor(state, activeId)`, which returns the remembered width or
falls back to the kind default (`defaultWidthFor(kindOf(paneId))`). `Dock` is fully controlled —
it renders the width it receives and calls `onWidthChange` on drag; it holds no local
width state and performs no clamping itself. The store is the sole clamp site.

### Layer split: DockHost connector + Dock presentational

`Dock.tsx` is a presentational component (props-in, callbacks-out, no store import).
`DockHost.tsx` is the thin store connector: it subscribes to the right slice, passes the
resolved width, and delegates `onClose` to `App` because some panes have side effects
only App owns (clearing `pdf.openDocId` or `focusedId` — spec §2 / §4 C2 / §4 I1).

### Tab strip: pay-as-you-go

`Dock.tsx` renders `<DockTabs>` at `openPaneIds.length >= 2`. A single-pane dock renders
a quiet `title ×` header. A user who has never opened a second pane never sees a tab.

### This is the codebase's third client-UI-state zustand store

ADR 0040 established the pattern: DB state → react-query; component `useState` for
local transient state; genuinely mutable app-global client-UI state → zustand. The
dock store is the **third** `create()` zustand store on this branch, after the command
registry (`useCommandStore`, ADR 0040) and the v0.6 PDF excerpt store (`useExcerptStore`,
which self-describes as mirroring the ADR 0040 command-registry pattern). The dock state
fits the same category: it is client view-state that outlives any single component, has
no DB round-trip, and must be available to components that are not in the same subtree.

### Scope: in-memory per window session

The dock layout is not persisted. Vision §Dock shell states explicitly: *"no saved
workspaces/presets until layouts demonstrably hurt to reconstruct."* For v0.6.2 the
dock resets to empty on every cold start. The one already-persisted bit (`pdf.openDocId`
in `app_settings`, ADR 0042) drives an explicit `App` effect that calls `openPane('pdf')`
on boot — it restores *which* PDF, not pane geometry.

## Alternatives

- **App `useState` booleans** — the pre-v0.6.2 approach. Works for a single pane per
  dock but cannot model an ordered list + active tab without introducing parallel arrays
  or an ad-hoc record, both of which degenerate into a hand-rolled store. Rejected
  because the forcing function (backlinks + pdf sharing a dock) makes an ordered-list
  model strictly necessary.

- **react-query** — rejected. Dock layout is client view-state; it has no DB round-trip
  and no server synchronisation concern. Using react-query for it would violate the
  taxonomy established in ADR 0040 (client UI state → zustand; DB/server state →
  react-query) and add unnecessary IPC noise.

- **A new zustand store per dock side** — considered and rejected. Splitting into
  `leftDockStore` and `rightDockStore` would make cross-dock queries (e.g., the
  suppression check `s.right.openPaneIds.includes('backlinks')`) require importing two
  stores. A single `DockStore` with `left`/`right` slices is simpler and keeps the
  boundary in one place.

- **Persisted workspaces / dock presets** — deferred per vision §Dock shell. The
  in-memory model is the right starting point; if layouts become hard to reconstruct a
  `zustand/middleware/persist` wrapper or a DB snapshot can be added without reshaping
  the store.

## Consequences

- **Future seams are additive, not reshaping.** Cross-dock tab dragging needs only a
  `moveTab(fromSide, toSide, paneId)` action. Left-dock tab-mates (shelf + a future
  pane) follow the same ordered-list model. An AI-chat pane registers itself in `PANES`
  with a `homeDock`. Dock-layout persistence wraps the existing store with a
  `persist` middleware or snapshots `widths` to `app_settings`. None of these
  require changing the slice shape.

- **`pdf.openDocId` restore (ADR 0042) stays clean.** The explicit App `[pdfOpenId]`
  effect calls `openPane('pdf')` when a persisted doc id is present. It restores content,
  not geometry — the dock width defaults on each boot, consistent with the no-presets
  rule.

- **Dock is fully controlled.** Consumers pass width in; the store clamps it. Prop
  drilling is intentional: `Dock` stays testable without a store mock.

- **Idle dock renders null.** `DockHost` returns `null` when `activeId` is null (no
  open panes). The center stage expands to fill the space with no layout artifact.

## Sources

- `docs/specs/v0.6.2-dock-shell.md` §1 (store shape), §2 (DockHost/Dock split), §6
  (pane registry)
- `docs/canvas-vision.md` §Dock shell + principle 7 (tabs as text labels,
  pay-as-you-go chrome, no saved workspaces/presets)
- `adrs/0040-command-palette-generalization-and-zustand.md` — first zustand store;
  establishes the DB/client-UI state taxonomy this store follows
- `adrs/0042-app-settings-store.md` — `pdf.openDocId` persistence; the in-memory dock
  deliberately leaves this as the only persisted dock-related bit
- `src/renderer/src/panes/dockStore.ts` — store implementation
- `src/renderer/src/panes/dock-widths.ts` — `DOCK_WIDTH` band constants, `clampWidth`,
  `defaultWidthFor`
- `src/renderer/src/panes/DockHost.tsx` — store connector
- `src/renderer/src/panes/Dock.tsx` — presentational dock; tab-strip threshold at line 78
- `src/renderer/src/panes/Pane.tsx` — `PANES` registry with `homeDock` routing
