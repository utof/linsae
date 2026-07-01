# 0046 — Backlinks dual surface (transient focus-overlay + deliberate dock pane)

Status: superseded by [0047](0047-feed-default-width-docks-fill-gutters.md) (v0.6.3)

> **Superseded:** v0.6.3's Model A layout (ADR 0047) removes the dock-open layout
> *shift* that was this ADR's sole justification for a separate transient overlay.
> The overlay (`BacklinksPane.tsx`) is retired; backlinks is now a single right-dock
> pane that opens on focus. The I1 (close → clear focus) and I2 (clear focus → close
> pane) invariants described below are preserved through that dock-pane path.

## Context

Backlinks were first surfaced in v0.1 as a right-side flex sibling of the note feed:
when a note bubble was focused the pane opened beside the feed, pushing it left to make
room. User feedback explicitly rejected this: the layout shift was *"annoying and too
much for such a small action"* (recorded in `BacklinksPane.tsx` line 18 and in the
`App.tsx` body-row comment at line 782). The fix was to make the pane an absolute
overlay that covers the feed's right edge without displacing it — the feed stays put,
the WindowFrame above stays visible, and the pane disappears on focus-clear.

That overlay is lightweight by design: it appears on a single bubble click and
disappears as soon as focus moves. However, a lightweight peek is the wrong shape for
a user who wants to keep the backlinks list open while navigating between notes — each
navigation clears focus and collapses the pane. The v0.6.2 dock shell added the
right-dock tab grammar (ADR 0045), which makes it possible to host backlinks as a
deliberately-opened, persistent dock pane that sits beside the PDF reader as a peer tab.

The design question was whether to *replace* the overlay with a dock pane (one surface)
or *add* a dock pane while keeping the overlay (two surfaces).

## Decision

**Keep the transient focus-overlay AND add a deliberately-opened right-dock utility pane.
One list implementation (`BacklinksPaneBody`) reads `BacklinksContext`; it is rendered
in both surfaces without duplication.**

### Implementation shape

`BacklinksPaneBody` is a prop-free component that reads `{ focusedId, onJump }` from
`BacklinksContext`. The overlay (`BacklinksPane.tsx`) wraps it in its own
`BacklinksContext.Provider` using locally-passed props. The dock pane uses the same
`BacklinksPaneBody` render thunk from the `PANES` registry, fed by a
`backlinksContextValue` that App memoizes around the dock region and the overlay site.
One implementation; two mounting points.

### Suppression rule

While the backlinks dock pane is open, the overlay does not render:

```tsx
{focusedId && !backlinksDockOpen && <BacklinksPane … />}
```

where `backlinksDockOpen = useDockStore(s => s.right.openPaneIds.includes('backlinks'))`.
This prevents double-backlinks: the lightweight peek is suppressed while the deliberate
pane already shows the same list.

### I1 — Close-clears-focus

Closing the backlinks dock pane (its tab `×` or `DockHost`'s `onPaneClose`) calls
`setFocusedId(null)` in addition to `closePane('backlinks')`. This is App's
`handlePaneClose` handler (defined at `App.tsx` line 172; the backlinks branch is the
statement at line 176):

```ts
if (paneId === 'backlinks') setFocusedId(null)
```

Clearing focus ensures the dismissed pane does not silently resurrect: if the
suppression guard were lifted without clearing `focusedId`, the overlay would
immediately reappear at the same position. I1 makes "close backlinks" a complete
dismissal.

### I2 — Focus-clear auto-closes

When `focusedId` clears while the backlinks dock pane is open, the pane closes
automatically. A dedicated App `[focusedId]` effect handles this (`App.tsx` lines
381–388):

```ts
useEffect(() => {
  if (focusedId == null && useDockStore.getState().right.openPaneIds.includes('backlinks')) {
    useDockStore.getState().closePane('backlinks')
  }
}, [focusedId])
```

A backlinks pane with no subject note is dead chrome. I2 ensures the dock pane closes
rather than showing an empty or stale list. Together, I1 and I2 settle without a loop:
when the user closes the tab, I1's `closePane('backlinks')` removes the pane *before* it
clears focus, so by the time the I2 effect re-runs on the focus change its guard
`right.openPaneIds.includes('backlinks')` is already false — `closePane` is never reached
a second time (matching the code comment at `App.tsx` lines 381–383).

### Command registration: dedicated `[focusedId]` effect, not a `when` gate

The `backlinks.open` command is present in `⌘K` only while a note is focused. It is
registered and unregistered by its own App effect keyed on `[focusedId]`:

```ts
useEffect(() => {
  if (focusedId == null) return
  store.register({ id: 'backlinks.open', label: 'Open backlinks',
                   run: () => useDockStore.getState().openPane('backlinks') })
  return () => store.unregister('backlinks.open')
}, [focusedId])
```

A register-once `when: () => focusedId != null` gate was explicitly rejected. The
`CommandMenu` evaluates `when()` against the closure captured at registration time
(`CommandMenu.tsx` lines 93–96, `useMemo([registry])`). A register-once `when` would
capture the mount-render `null` and never show the command. Rather than re-registering
the entire base-command set on every focus change (which is the cost of keying the full
registry's `useMemo` on `focusedId`), backlinks gets its own dedicated effect that
registers/unregisters exactly one command as focus comes and goes.

## Alternatives

- **Replace the overlay with the dock pane** — rejected. This re-introduces the layout
  shift that the original feedback rejected. Opening the dock pane is an intentional
  action; it pushes the center stage left by the pane's width. That is acceptable for a
  deliberate open (identical to opening a PDF), but it is the wrong behavior for a
  passive focus side-effect. The overlay's absolute positioning specifically avoids the
  shift.

- **Dock pane only, no overlay** — rejected. This is the largest behavior change and
  loses the lightweight peek the overlay provides. A user who clicks a bubble to see its
  backlinks now has to issue an explicit command; the zero-friction inspection path
  disappears. The original user feedback objected to the *shift*, not to the *pane's
  existence*; the overlay solution resolves the objection without removing the feature.

- **A register-once `when`-gated command** — rejected. As described in the Decision
  section, `CommandMenu` evaluates `when()` at registration time; a `when` closure
  capturing `focusedId` would be stale on every subsequent focus change. The dedicated
  `[focusedId]` effect is slightly more verbose but correct: the command is in the
  registry only while the closure-captured `focusedId` is non-null, because the effect
  re-runs (and re-registers) each time focus changes.

- **Always-mounted-but-hidden overlay** — rejected. Keeping `BacklinksPane` mounted
  when `focusedId` is null would render the aside frame (border, header chrome) into
  the layout and keep a `useQuery` subscribed with no note id. The Esc-precedence
  resolver in spec §Keyboard tests for the pane's DOM presence to decide whether Esc
  should close it or fall through; an always-mounted pane would break that test.
  (`BacklinksPane.tsx` TSDoc explains this explicitly.)

## Consequences

- **One list implementation, two surfaces.** `BacklinksPaneBody` reads context; it
  cannot diverge between the overlay and dock pane. Future changes to the backlinks
  list (e.g., snippet display, sort order) need only one edit.

- **Deliberate open pushing the stage is acceptable.** The dock pane is an intentional
  action — the user issued `backlinks.open` from `⌘K` or a future toolbar button. A
  layout shift that follows an intentional action is standard dock behavior (identical
  to opening the PDF reader). The feedback objected to a passive side-effect of a
  focus click, not to layout shifts in general.

- **`focusedId` stays App-owned `useState`.** The backlinks context value is memoized
  in App (`backlinksContextValue = useMemo(() => ({ focusedId, onJump: setFocusedId }),
  [focusedId])`) and provided around both the dock region and the overlay site. No store
  lift is needed; the existing ownership model is unchanged.

- **Suppression is a one-liner.** The `!backlinksDockOpen` guard in the overlay's
  render condition is the only coordination between the two surfaces. If the dock pane
  is removed in a future milestone, removing that guard restores the original overlay
  behavior with no other changes.

## Sources

- `docs/specs/v0.6.2-dock-shell.md` §3 (BacklinksPaneBody / BacklinksContext
  extraction), §4 (dual-surface decision, suppression, I1, I2), Decisions 4 & 5
- `src/renderer/src/backlinks/BacklinksPane.tsx` line 18 — feedback quote: *"the shift
  is annoying and too much for such a small action"*
- `src/renderer/src/App.tsx` line 782 — same feedback quote in body-row comment
- `src/renderer/src/backlinks/BacklinksPaneBody.tsx` — shared list implementation
- `src/renderer/src/backlinks/BacklinksContext.tsx` — `BacklinksContext`,
  `BacklinksContextValue`, `useBacklinks`
- `src/renderer/src/backlinks/BacklinksPane.tsx` — overlay shell (absolute-positioned)
- `src/renderer/src/App.tsx` lines 122–124 (`backlinksDockOpen` suppression gate),
  lines 172–176 (`handlePaneClose`: I1 clears focus), lines 365–379 (`[focusedId]` command
  register/unregister effect), lines 381–388 (I2 auto-close effect), line 998
  (overlay suppression render condition)
- `adrs/0040-command-palette-generalization-and-zustand.md` — command registry; explains
  why `when()` closures are evaluated at registration time, making a `when`-gated
  register-once approach incorrect
- `adrs/0045-dock-ordered-panes-zustand.md` — dock store; the dock pane opens via
  `useDockStore.getState().openPane('backlinks')`
