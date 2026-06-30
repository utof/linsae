# 0047 — Model A: feed keeps a default/max centered width; docks fill the side gutters

Status: accepted (v0.6.3)

## Context

ADR 0045 made the dock an ordered list of panes per side; ADR 0046 added backlinks
as a dock pane while keeping a transient focus-overlay, on the explicit premise
that *"deliberate open pushing the stage is acceptable"* — opening a dock shrank the
center `<main>` (a flex sibling), pushing the feed.

Live use exposed two problems with the push/shrink model:

- **B3 (asymmetry):** the left dock (shelf) pushed the feed *right*, the right dock
  pushed it *left*. Because the feed is a centered, max-width band inside `<main>`,
  shrinking `<main>` re-centered the band within the smaller area — so the feed
  *shifted* even though plenty of horizontal space remained beside it.
- **B1 (unwanted shift):** opening any dock moved the feed at all, when the window
  was wide enough that the dock could have sat in the empty gutter beside the feed
  without disturbing it. ADR 0046 itself records the original user objection to the
  v0.1 flex-sibling backlinks pane: *"the shift is annoying and too much for such a
  small action."*

The user approved a replacement layout model ("Model A"). The question: how should
the feed, the gutters, and a resizable dock share the window width?

## Decision

**The feed has a default width that is also its maximum (`FEED_BAND.default = 720`,
the value it has always used). The feed stays centered in the WINDOW. An open dock
fills the gutter between the feed and the window edge; it does not move or shrink the
feed while free gutter space exists. Widening a dock past its gutter is what
eventually encroaches: the feed then shrinks — down to `FEED_BAND.min = 360`, never
to zero — and slides flush against the dock rather than under it. Symmetric for both
docks.**

### Mechanism: a pure geometry function, measured width, controlled margins

The docks stay flex siblings of `<main>` (the canvas still shrinks when a dock opens
— see Consequences). The *feed* alone is re-centered. App measures the body-row
width (`ResizeObserver`), reads the open dock widths from the dock store
(`dockWidthFor`), and calls `computeFeedBand(winW, leftW, rightW)`
(`src/renderer/src/feed/feedBand.ts`). That function returns
`{ maxWidth, marginLeft, marginRight }` (or `null` when no dock is open / width
unmeasured), which `<Feed>` applies to its band in place of the default
`maxWidth: 720; margin: 0 auto`.

The math runs in window coordinates: `<main>` spans `[leftW, winW − rightW]`, so a
window-centered band's left edge is `(winW − width) / 2`; that position is then
clamped so the band never crosses either dock's inner edge, and converted back to
margins relative to `<main>`'s content box. Both docks pass through the identical
clamp, so the behavior is symmetric by construction. The feed width itself is
`clamp(FEED_BAND.min, FEED_BAND.default, winW − leftW − rightW)`.

**Feed and composer are one unit.** The new-note composer is a sibling of `<Feed>`
in the feed column (not a child), so App threads the SAME `band` value to both. The
composer applies it to its own centered band exactly as the feed does, so the two
stay horizontally aligned and drift/shrink together (B13). They are not wrapped in a
single band container only because `<Feed>`'s band div hosts its scroller, thumb,
and scroll-pill — extracting it would be a risky restructure for no behavioral gain.

**The dock is hard-capped so it can never overlap the feed (B14).** App is the
geometry owner: it derives each dock's *effective* render width and resize cap from
the measured window and BOTH stored widths (`maxDockWidth(kind, otherWidth, winW)` =
`clamp(kindMin, kindMax, winW − FEED_BAND.min − otherWidth)`), feeding the SAME
effective widths to both the rendered docks (`<DockHost width maxWidth>`) and
`computeFeedBand`. So the feed column always keeps ≥ `FEED_BAND.min` and the docks
can never draw over the feed — invariant to how many panes/docks are open (each side
is capped against the other's width, keeping `leftEff + rightEff ≤ winW − feedMin`).
As reinforcement the feed/composer band divs carry **no CSS `min-width`**: the band
shrinks to fit `<main>` so it can't overflow under a dock even on a pathologically
narrow window (there the dock floors at its kind-min and the feed yields past its
nominal min — degraded, but still no overlap). This replaces the original "floor the
feed, don't constrain the dock" approach, whose missing dock cap let the dock grow
until the feed's `min-width` forced an overflow *under* the panel (the reported bug).

**One width per dock SIDE, not per pane (B15).** The store keys `widths` by
`left`/`right` (seeded to the first-opened pane's kind default, updated on resize,
clamped to the *resized* pane's kind band), so switching the active tab (pdf ↔
backlinks) never changes the dock's width.

**The top toggle collapses the whole SIDE, not one tab (B19).** A per-side
`collapsed` flag (top-level in the store, separate from the slice) hides a whole
side while keeping its `openPaneIds`/`activeId`/width intact, so toggling back
restores exactly what was there (the B15 per-side width re-applies within the
current window cap automatically). A collapsed (or empty) side reads as "not shown"
(`isSideShown`), which makes it contribute **0** to the geometry above — the feed
reclaims the space — and makes `DockHost` render nothing. `toggleSide(side)`:
shown → `collapseSide`; collapsed → restore; fresh (never opened) → open the side
default (right → backlinks, left → shelf — matching the prior B2 toggle). The per-tab
`×` (B5) still closes a single pane; only the top toggle collapses the side.
Symmetric for both sides.

*Collapse vs. the focus→backlinks auto-open (B6).* `openPane` clears the collapse
flag (opening a pane reveals its side). Because the focus→auto-open effect is keyed
`[focusedId]` and only fires on a focus **change**, an explicit collapse holds while
the same note stays focused (the effect never re-runs), and is only undone by the
toggle or by focusing a **different** note (which calls `openPane`, clearing the
flag). Collapse does not touch `focusedId`, so it doesn't reintroduce the I1/I2
loop and the remembered subject note survives the round-trip.

### Backlinks collapses to a single dock-pane surface (supersedes ADR 0046)

Model A removes the layout *shift* that was 0046's sole justification for keeping a
separate transient overlay alongside the dock pane. With the shift gone, the
dual-surface design loses its reason to exist, so:

- `BacklinksPane.tsx` (the absolute overlay) is **retired**.
- Focusing a note now **opens the backlinks dock pane** directly (a `[focusedId]`
  effect: focus → `openPane('backlinks')`, blur → `closePane`). This folds the
  overlay's "show on focus" behavior into the one dock surface.
- A visible, always-reachable **toggle** in `WindowFrame` (mirroring the shelf
  toggle) opens/closes backlinks independent of focus (B2).
- Because the dock is body-row chrome rendered outside the feed/canvas
  `AnimatePresence`, its close affordance (quiet header `×`, or per-tab `×` when it
  shares the dock with the PDF reader) is reachable from the canvas view too (B5),
  wired to I1 (`handlePaneClose` clears focus).

The loop-prevention invariants are preserved through the dock-pane path: **I1**
(close → clear focus) and **I2** (clear focus → close pane) settle without a loop
because each runs `closePane` against a guard that the other has already satisfied.

### Feed→canvas selection carry-over (B4)

When a focused feed note is placed on the canvas, App passes its id to `CanvasStage`
as `selectNoteId`; the stage selects that card once on mount (it remounts per
feed→canvas swap under `AnimatePresence mode="wait"`). One-directional — canvas
selection never writes back to feed focus. App gates the prop on placement, so a
non-placed note is never selected.

## Alternatives

- **The old push/shrink model (ADR 0046)** — rejected. It is exactly what produced
  B1/B3: shrinking `<main>` re-centers the feed band within it, so the feed shifts
  whenever a dock opens, regardless of available gutter space.

- **Elastic feed (no max; feed always fills `<main>`)** — rejected. The feed is a
  reading column; letting it stretch to fill a wide window hurts line length, and a
  dock opening would still re-flow it. A fixed default/max keeps the reading measure
  stable and is what makes "dock fills the gutter, feed unmoved" possible.

- **Feed centered in the remaining space (between the docks)** — rejected. This is
  effectively the current flex auto-centering; a single open dock still shifts the
  feed toward the opposite edge. It does not satisfy "feed unmoved while gutter space
  exists."

- **Absolute-overlay docks (docks float over a full-width `<main>`)** — considered.
  It would make the feed window-centering automatic (no margin math) and the width
  clamp pure-CSS, but it changes the *canvas*↔dock relationship (the PDF dock would
  overlay the canvas instead of shrinking it), reversing 0046's accepted
  "deliberate open pushes the stage" for the canvas with a larger blast radius than
  the feed-only fix needs. Rejected to keep canvas behavior unchanged.

- **Position-clamp only, leave the dock uncapped** — this was the *first* cut and it
  was wrong (the B14 bug). With no dock cap the dock could widen until the feed
  column dropped below `FEED_BAND.min`; the band's `min-width: 360` then forced an
  overflow *under* the (later-DOM-sibling, opaque) dock, so the panel drew over the
  feed. The fix adds the window-aware dock cap (`maxDockWidth`, above) AND drops the
  band's `min-width`. The earlier worry — that capping the dock couples shared chrome
  to the feed min — is real but acceptable: the cap only binds on a *narrow* window
  (e.g. PDF can't reach 900 below ~1260 px wide), and the alternative is the feed
  vanishing or the dock overlapping it, both worse. On the canvas (no feed) the dock
  is still flex-capped by `<main>` shrinking, unaffected by this render cap.

## Consequences

- **The feed no longer shifts on a small dock open.** Opening backlinks/shelf/PDF at
  its default width on a normal window leaves the feed dead-centered; the dock fills
  its gutter. Widening the dock is the deliberate gesture that eats into the feed.

- **Canvas behavior is unchanged.** Docks remain flex siblings, so opening a dock
  still shrinks the canvas stage (0046's accepted behavior). Only the feed branch
  re-centers. The feed↔canvas `AnimatePresence` slide is untouched.

- **One backlinks surface, not two.** `BacklinksPaneBody` is now mounted only in the
  dock; the suppression guard and the overlay component are gone. Backlinks and PDF
  appear as peer tabs of the single right dock (DockTabs at ≥2 panes).

- **App re-renders on dock-drag.** App subscribes to the dock widths and the measured
  body width, so a resize drag re-renders App + Feed. The band is two cheap style
  values and the feed's rows are compiler-memoized (ADR 0006), so the cost is small;
  if it ever matters it can move to CSS variables set imperatively.

- **`FEED_BAND.min = 360` is a chosen floor.** Below it a reading column gets too
  cramped; it is the smallest the feed shrinks to before the dock simply can't widen
  further usefully. Bump it if 360 proves tight.

## Sources

- `src/renderer/src/feed/feedBand.ts` — `computeFeedBand` + `FEED_BAND`; the pure
  geometry, unit-tested in `feedBand.test.ts`
- `src/renderer/src/feed/Feed.tsx` — band application (replaces the hardcoded
  `maxWidth: 720; margin: 0 auto`)
- `src/renderer/src/App.tsx` — body-row `ResizeObserver`, dock-width selectors,
  `computeFeedBand` memo, focus↔backlinks-pane coupling, `selectNoteId` wiring
- `src/renderer/src/topbar/WindowFrame.tsx` — B2 backlinks toggle (mirrors the shelf
  toggle)
- `src/renderer/src/canvas/CanvasStage.tsx` — B4 `selectNoteId` mount-selection
- `adrs/0045-dock-ordered-panes-zustand.md` — dock store + width bands this builds on
- `adrs/0046-backlinks-dual-surface.md` — the dual-surface decision this supersedes;
  I1/I2 invariants preserved through the dock-pane path
