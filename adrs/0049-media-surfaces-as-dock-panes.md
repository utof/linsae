# 0049 — Media surfaces (PDF reader + YouTube player) are right-dock content panes

Status: accepted (v0.6.4)

## Context

Through v0.6.3 there were two media surfaces with very different lifecycle behaviors:

**PDF reader** — already a right-dock content pane (shipped in v0.6, ADR 0043).
Survives `feed ⇄ canvas` transitions because docks are always mounted (body-row
chrome). Correct.

**YouTube `<webview>` player** — pinned *inside* `ThreadView`. Because `ThreadView`
rendered as part of the center stage, navigating away from a thread (switching to the
canvas, or closing the thread to return to the feed) unmounted `ThreadView` and with
it the `<webview>`. The player's session and playback position were lost on every
stage change.

The single-mount invariant that makes the YouTube player safe is documented in
`adrs/0016` (webview teardown) and `adrs/0017` (persist partition for the session
cookie). Pinning the player inside `ThreadView` violated that invariant the moment
`ThreadView` became a conditionally-mounted branch of `<main>` (ADR 0048).

v0.6.4 reframes the question: the player is a *content surface*, not a *thread
component*. It belongs beside the PDF reader in the right dock.

## Decision

**Both media surfaces are right-dock content panes, decoupled from the center stage.**

The YouTube player is extracted from `ThreadView` into `PlayerPane`
(`src/renderer/src/panes/PlayerPane.tsx`), which is registered in the `PANES` registry
with `homeDock: 'right'` and `kind: 'content'` — the same class as the PDF reader pane.
`PlayerPane` is the **sole mount site for `usePlayer`**. This restores the single-mount
invariant: the `<webview>` is never unmounted across stage transitions because the dock
is always mounted (ADR 0048 consequence).

`ThreadView` still reads playback state for the video-order rail and timestamp display,
but it does so via a new read-only `usePlayerState` hook that consumes the store without
mounting the player. No duplicate `<webview>` is created.

The `position:fixed` CSS singleton layout of the webview, the
`partition="persist:yt-player"` session cookie, and all existing player IPC channels
are untouched.

When a media note's thread is opened, `App` calls `openPane('player')` so the dock
surfaces the player beside the thread (commit `02ebeac`). Closing the thread collapses
the thread view; the player dock pane remains open.

## Alternatives

- **Keep the player pinned inside `ThreadView`** — rejected. Under the ADR 0048
  sub-view model, `ThreadView` is mounted/unmounted on thread open/close. The player
  would be torn down on every thread exit, losing playback position and violating the
  single-mount invariant (ADRs 0016 + 0017). The user cannot watch a video while
  on the canvas.

- **Re-parent the `<webview>` into a portal outside the thread tree** — considered.
  Electron's webview teardown behavior on DOM removal (tracked upstream as
  electron#9529 / #7700) makes re-parenting unsafe: the webview session is destroyed
  on the unmount even if it is immediately remounted elsewhere. The dock-pane approach
  avoids re-parenting entirely; the webview stays in a stable subtree.

- **Duplicate `<webview>` — one in the dock, one in the thread** — rejected. Electron
  does not support two `<webview>` instances sharing one session. Audio and network
  requests would be duplicated.

## Consequences

- **Watch or read while on the canvas.** Opening the canvas while media is docked no
  longer closes the player or the PDF reader — both persist across `feed ⇄ canvas`
  and across thread open/close.
- **Player persists across feed⇄canvas.** Playback position and session survive all
  center-stage transitions. The `persist:yt-player` partition retains its cookie.
- **Re-surfaced transport controls are deferred.** `PlayerPane` currently renders the
  `<webview>` only; the scrubber, speed control, and timestamp-follow toggle that were
  in `ThreadView`'s header are not yet re-exposed in the dock pane. Tracked as
  issue #169 (p1).
- **Playwright-Electron smoke is un-run.** The player-lift was verified via manual
  dogfooding; a Playwright-Electron smoke for the docked player coexisting with the
  canvas has not been run in the automated harness. Tracked as part of issue #169.
- **Adds a second right-dock content pane class entry.** The PDF reader and the player
  are now peer content tabs in the right dock when both are open, rendered via
  `DockTabs` (ADR 0045 tab-strip-at-≥2 rule).

## Sources

- Commit `4ab51f0` — "player lifts into a right-dock pane; persists across feed|canvas (B5)"
- Commit `02ebeac` — "(re)open the media dock pane when a media note's thread opens (#166)"
- `src/renderer/src/panes/PlayerPane.tsx` — sole `<webview>` mount site
- `adrs/0016-webview-youtube-player.md` — single-mount invariant
- `adrs/0017-youtube-auth-cookie-and-servicelogin.md` — `persist:yt-player` session
- `adrs/0045-dock-ordered-panes-zustand.md` — dock registry, content-pane kind
- Issue #169 — docked-player transport controls (scrubber/speed/follow)
