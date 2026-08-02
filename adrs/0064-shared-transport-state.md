# 0064 — The docked player's transport state lives in a store shared by two sibling panes

Status: accepted (v0.8.2)
Date: 2026-08-02

## Context

v0.6.4's Task B5 (`4ab51f0`) lifted the YouTube player out of `ThreadView` into the right-dock
`PlayerPane`, so the guest survives the centre stage flipping feed ↔ thread ↔ canvas. In the same
commit it dropped `ThreadView`'s `<TransportBar>` and did not remount it anywhere.

YouTube's own controls are suppressed inside the guest — `src/renderer/src/yt/inject/youtube-guest.ts:121`
sets `v.controls = false`, and `CLEAN_CSS` hides `.ytp-chrome-bottom`. So from `4ab51f0` until v0.8.2
the docked player had **no scrubber, no time readout, no speed badge, no follow toggle and no
fullscreen button**: two milestones of a player you could only start by clicking the video itself.
That is #169.

`TransportBar` is purely presentational — six data props and five callbacks. The callbacks were never
the obstacle: `usePlayer` returns the full singleton handle (`usePlayer.ts:57`), which already exposes
`play` / `pause` / `seekTo` / `setPlaybackRate` / `toggleFullscreen`, and calling those mounts nothing,
so the single-mount invariant (ADR 0016) is not in play. **Three of the six data props had no source,
and two of those are cross-pane:**

- **`followOn` is not a display flag.** It gates `ThreadView`'s follow auto-scroll and
  `jumpPillDirection`, whose first line is `if (mode !== 'video' || followOn) return null`
  (`src/renderer/src/thread/rail-layout.ts:179`). While the value was hardcoded — `ThreadView.tsx:260`
  was `const followOn = true` from `4ab51f0` — **the jump-to-now pill could not render in production
  at all**, for two milestones. The comment above the hardcode said the toggle "now lives in
  PlayerPane"; the bar was mounted nowhere, so the toggle existed nowhere. The comment documented a
  state of the world that had never been true.
- **`rate` did not exist anywhere.** `Player` (`src/shared/player.ts`) has a `setPlaybackRate` and no
  `getPlaybackRate`, so there is nothing to read it back from. Pre-B5 it was `useState(1)` plus a
  `RATES` array in `ThreadView`, all deleted in `4ab51f0`.
- **`markers`** are the thread's anchored timestamps. `PlayerPane` has no access to them; it knows a
  `videoId` and nothing else.

**`PlayerPane` and `ThreadView` are siblings.** `App.tsx:1222` renders the right `<DockHost>` and
`:1228` opens the `<main>` that holds the thread branch; they are peers in one flex row, with `App` the
nearest common ancestor. Nothing about "the toggle lives in PlayerPane" could ever have worked as
pane-local state — it would have recoloured a button in the dock and changed nothing in the notes
column.

### Why nothing flagged this: knip counts a test import as usage

For two milestones `TransportBar.tsx` had exactly **one** importer, its own
`TransportBar.test.tsx` — verified at `7345e53^`, where the only occurrences of the name in
`ThreadView.tsx` are three comments (`:62`, `:257`, `:302`). `rail-layout.ts`'s `markerPositions` was
in the same state: `rail-layout.test.ts` and nothing else. The precommit `knip` step passed on every
one of those commits.

That is not a knip misconfiguration, it is knip working as specified. `knip.json`'s `entry` list names
`tests/**/*.test.{ts,tsx}`, and knip's vitest plugin additionally treats each project's own `include`
globs as entries — `vitest.config.ts:36` is `src/renderer/**/*.test.{ts,tsx}`. A co-located test is
therefore an entry, a file reachable from an entry is "used", and an export imported by one is not an
unused export. **A component with a thorough unit test and no production call site is invisible to
every static gate this repo runs.** Expect this to recur; it is the reason B4 exists.

The blind spot has a sharp edge on the other side, which is why `useMarkerPublisher` could not be
written during B1: an export with **no** importer at all *is* flagged, so the hook had no legal home
until `ThreadView` consumed it in B3 (`transportState.test.ts` imports only `useTransportStore`;
`ThreadView.tsx` is the hook's sole importer today). The same rule that hid a dead component would
have blocked a live one from landing early.

## Decision

**Add `src/renderer/src/yt/transportState.ts`: a zustand store holding `{ followOn, rate, markers }`
with `toggleFollow` / `cycleRate` / `setMarkers` / `clearMarkers`, plus a `useMarkerPublisher(markers)`
hook. `PlayerPane` reads all three and writes the first two; `ThreadView` reads `followOn` and
publishes `markers`.**

This is the codebase's client-UI-state pattern, not a new one: ADR 0040 fixed the taxonomy (DB state →
react-query, local transient → `useState`, app-global client-UI state → zustand), and the store is
shaped after `pdf/excerptState.ts` and `pdf/pendingJumpState.ts`. It is deliberately side-effect-free —
it never touches the player singleton, so it stays testable without a YouTube guest and cannot violate
ADR 0016.

### Two lifetimes, deliberately

- **`followOn` and `rate` are player-scoped and have NO reset.** They must survive `ThreadView`
  unmounting while the docked player keeps playing, which is the entire point of the B5 lift.
- **`markers` are thread-scoped.** `ThreadView` is the sole publisher and owns the teardown. Keeping it
  a publisher obligation avoids keying the store by `videoId`, which the plan's "small store" (§3.2)
  does not call for.

`useMarkerPublisher` exists so that publish and teardown **cannot be separated**. B1 could only state
the pairing in prose, and a prose-only contract is precisely what rotted for two milestones and
produced #169. Without the teardown one thread's ticks stay on the docked scrubber over the *next*
video. It is two effects, not one: folding the clear into the publish effect's cleanup would empty the
list on every republish — a visible flicker and two store writes where one belongs.

### "Player-scoped" names the store's lifetime, not the player's

`rate` is held **only** here. `load(id)` reassigns the webview's `src` (`playerSingleton.ts:299-307`),
a full guest reload that destroys the `<video>` the guest's `setRate` handler wrote to
(`inject/youtube-guest.ts:203`), and there is no `getPlaybackRate()` to read the truth back. The store
never pushes. Re-pushing is therefore a **standing consumer obligation**, and `PlayerPane` carries it
(`PlayerPane.tsx:119-121`) with `state` in the deps on purpose: `setPlaybackRate` is
`rpc?.invoke('setRate', r)` and `load()` nulls `rpc` until the reloaded guest's dom-ready re-creates
it, so a push fired at videoId-change time is swallowed. A state event is the only public signal that
the new port is live. Without this the badge reads 1.75× while playback runs at 1×, silently.

`cycleRate()` advances the store **and returns** the new rate, so `RATES` stays module-local and the
call site is `player.setPlaybackRate(cycleRate())` instead of a set followed by a re-read.

### The gate is a real-Electron smoke, not a unit test

Task B4 extends `scripts/thread-smoke.mjs` rather than adding Vitest coverage, because the claims this
ADR makes are geometric and happy-dom has no layout: `getBoundingClientRect()` is all zeros there, so
`TransportBar.tsx:123` takes its `rect.width > 0 ? … : 0` fallback and every unit-level track click
seeks to 0:00, and `jumpPillDirection` reads `0 < 0 + 8` and answers `'up'` unconditionally. Four gates
run without a guest (bar present, webview not painting over the bar, follow crossing panes, rate badge
cycling); six more need a live `<video>` and sit behind `SMOKE_PLAYBACK=1`, because `duration` is only
ever written from an RPC event. Two of the four carry a **counterfactual executed in the live tree** —
the host is shrunk and the bar pulled under it, the predicates are checked red, and the layout is
restored — so "this gate can fail" is verified on every run rather than argued for once. **This is the
durable half of the fix**: the store can be re-broken by any future refactor, and knip will keep saying
nothing.

## Alternatives

- **Pane-local `useState` in `PlayerPane`.** Rejected — it is what the stale `ThreadView.tsx:257`
  comment claimed already existed. `followOn` would toggle a button colour in the dock while the notes
  column kept auto-scrolling and the jump pill stayed unreachable. The two components are siblings
  (`App.tsx:1222` / `:1228`); there is no parent-child path between them.
- **Lift the state into `App` and pass props down.** Rejected. `PlayerPane` is reached through the pane
  registry, whose entries render a zero-argument thunk — `render: () => ReactNode`
  (`panes/Pane.tsx:27`), `render: () => <PlayerPane />` (`:50`). Threading a transport prop through
  would mean giving `PANES`, `DockHost` and `Dock` a transport-shaped surface that no other pane wants,
  to serve exactly one pane.
- **A React context provider at `App`.** Rejected for the same threading reason plus re-render breadth:
  `rate` and `followOn` change on user input and `markers` on a ~5 Hz-polled duration, and a context at
  `App` re-renders the feed, the canvas and both docks for each. zustand's selector subscription
  confines the churn to the two components that read the values.
- **Key `markers` by `videoId` inside the store.** Rejected as unnecessary: the publisher already knows
  when its thread ends, and `useMarkerPublisher`'s unmount cleanup is a smaller mechanism than a keyed
  map that would then need its own eviction rule.
- **Read the rate back off the player instead of storing it.** Not possible — `Player` exposes no
  `getPlaybackRate()`, and adding one would mean asking a guest that may have just been destroyed.
- **Persist `followOn` / `rate` to `app_settings` (ADR 0042 / 0053).** Deferred. They are session
  preferences, not documents; nothing in #169 asks for them to survive a restart, and each persisted
  key costs an IPC round-trip plus a react-query cache entry.
- **#169's other offered option: delete `TransportBar` and `markerPositions` rather than wire them.**
  Rejected — it contradicts `docs/specs/v0.2-youtube-annotation.md:240-243` and `:317`, and it would
  leave a docked player with no controls at all as the shipped design.

## Consequences

- **The jump-to-now pill renders in production for the first time since `4ab51f0`.** It was not a
  styling bug; it was unreachable code behind a hardcoded `true`. B4's `followCrossesPanes` gate is the
  guard, and it asserts the playhead row is *measurably* off-screen before trusting the direction,
  because the all-zero-rect environment answers `'up'` for free.
- **A silent rate divergence is now possible if the consumer obligation is dropped.** The store holds
  the only copy; anything that loads a new video without re-pushing on the next `state` event leaves
  the badge and the playback disagreeing with no error anywhere. Gated by
  `rateSurvivesGuestReload`, which drives a real second video through a real `load()`.
- **Marker teardown is mechanism, not prose.** Publish and clear cannot be separated by a future edit
  without deleting the hook outright.
- **`followOn` and `rate` reset on every cold start** — the store is in-memory, consistent with the
  dock's own no-persistence stance (ADR 0045).
- **The knip blind spot is unchanged and will recur.** Nothing here fixes it; `knip` still cannot
  distinguish "used by production" from "used by its own test". The only counter-pressure is that a
  component with no production call site now has a real-Electron gate that would notice.
- **`SMOKE_PLAYBACK=1` is currently red on this machine, for a reason outside the transport.** B4's
  first act was to find that the guest's MessagePort handshake comes up roughly one run in seven: the
  guest sits on the watch page with a healthy `<video>` and no consent lightbox, while the host never
  receives a single `state` event, so `duration` stays null and the whole live half is unevaluable.
  `onDomReady` is one-shot — `if (rpc || !wv) return` (`playerSingleton.ts:175`) — and `rpc` is
  assigned *before* the runtime injection and the port transfer, so a document swap between them
  orphans the port with no retry. `insertCSS` re-fires on every `dom-ready` because it sits outside
  that guard, which is why the chrome-hidden check passes in exactly the runs where the RPC is dead;
  it is not evidence either way. The smoke fails rather than skips in that state, and says which of
  the two it is. Filed as a follow-up, not fixed here: `yt/` was under concurrent review.
- **The scrubber's `fillPct` is deliberately NOT gated.** A seek made while paused never reaches the
  host — the guest listens for `seeked` but not `seeking` (`inject/youtube-guest.ts:131`) and its time
  loop only runs during playback — so the fill legitimately kept reading 0.1% while the guest sat at
  61.9%. The seek itself, which is what #169 is about, is gated. The fill is a separate follow-up.

## Sources

- `src/renderer/src/yt/transportState.ts` — the store and `useMarkerPublisher`
- `src/renderer/src/yt/PlayerPane.tsx` — the reader/writer; `:119-121` is the rate re-push
- `src/renderer/src/thread/ThreadView.tsx:268` (`followOn` from the store), `:277-281` (marker publish)
- `src/renderer/src/thread/rail-layout.ts:179` — `if (mode !== 'video' || followOn) return null`
- `src/renderer/src/thread/TransportBar.tsx:123` — the `rect.width > 0 ? … : 0` fallback that makes
  every happy-dom seek land at 0
- `src/renderer/src/yt/playerSingleton.ts:299-307` (`load` reassigns `src`, nulls `rpc`), `:337-339`
  (`setPlaybackRate` is an RPC invoke), `:150-167` (the `syncBounds` rAF loop)
- `src/renderer/src/yt/inject/youtube-guest.ts:121` (`v.controls = false`), `:203` (`setRate`)
- `src/renderer/src/App.tsx:1222` / `:1228` — `DockHost` and `<main>` as siblings
- `src/renderer/src/panes/Pane.tsx:27`, `:50` — `render: () => ReactNode`, the propless thunk
- `knip.json` (`entry`) + `vitest.config.ts:36` (`include`) — why a co-located test counts as an entry
- `scripts/thread-smoke.mjs` — the B4 gates
- `docs/plans/v0.8.2-composer-dataloss.md` §3–3.3, §8
- `docs/specs/v0.2-youtube-annotation.md:240-243`, `:317`, §ThreadView (follow = auto-scroll)
- `adrs/0040-command-palette-generalization-and-zustand.md` (the DB/client-UI taxonomy),
  `adrs/0045-dock-ordered-panes-zustand.md` (in-memory dock state),
  `adrs/0016-webview-youtube-player.md` (single-mount invariant),
  `adrs/0049-media-surfaces-as-dock-panes.md` (why the player is a pane at all)
- Issue: utof/linsae#169
- knip — entry files and the vitest plugin: https://knip.dev/reference/configuration#entry
