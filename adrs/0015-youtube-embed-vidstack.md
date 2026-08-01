# 0015 — YouTube embed/playback via Vidstack (vanilla `VidstackPlayer.create`) behind the player singleton

- **Status:** Superseded by [0016](0016-webview-youtube-player.md) (v0.2.1)
- **Date:** 2026-06-01
- **Amends:** ADR 0012 (Player interface with one implementation). The singleton architecture and the `Player` interface from 0012 are kept unchanged. The *engine* changes from `youtube-player` (sister.js IFrame wrapper) to Vidstack.
- **Applies to:** `src/renderer/src/yt/playerSingleton.ts` (engine swapped), `src/renderer/index.html` (CSP `frame-src`). `usePlayer.ts` and `ThreadView.tsx` are unchanged.

> This ADR is written to be auditable by a coding agent. Claims that an agent should be able to independently verify are collected in **§7 Verifiable facts (with sources)**. If any of those turn out false, treat the surrounding decision as suspect.

---

## 0. Implementation in this repo (divergence from the reference scaffolds)

This ADR shipped alongside three reference files (`playerSingleton.ts`, `usePlayer.ts`, `PlayerView.tsx`). Only the **engine** (`playerSingleton.ts`) was adopted as production code. Per §2 decision 3 — *keep the public interface unchanged so existing call sites keep working* — the other two were treated as reference, not drop-ins:

- **`usePlayer.ts` is unchanged.** The app's hook has a richer surface (`usePlayer(videoId, hostRef) → { player, currentTime, state, duration }`: rAF playhead tick + duration re-poll + state subscription) that `ThreadView`, `ThreadComposer`, the rail, and the duration write-back all depend on. The reference scaffold's bare `usePlayer() → { player, containerRef }` would have broken those call sites. The richer hook works as-is against the new singleton because the `Player` facade is identical.
- **No separate `PlayerView.tsx`.** `ThreadView` already renders the player region (re-parents the singleton wrapper into `hostRef`, draws its own `TransportBar`, owns the resizable/split layout and screenshot capture). The scaffold's overlay/`pointer-events:none` mechanism still applies — the `pointer-events:none` on the iframe lives in the **singleton's injected CSS** (`#yt-player-wrapper`), so it is in force regardless of which view mounts the wrapper.
- **CSP:** `frame-src` was widened to allow **both** `https://www.youtube-nocookie.com` and `https://www.youtube.com`. Empirically `vidstack@1.15.2` embeds the **nocookie** host (verified by `scripts/thread-smoke.mjs`: the embed iframe src is `https://www.youtube-nocookie.com/embed/…`), but the provider's host can shift with version / the `noCookie` option, so allowing both means the embed is never CSP-blocked regardless. The `youtube.com` `script-src` tokens (ADR 0008) are retained — the thread smoke's Error-153 probe loads `youtube.com/iframe_api` directly to test the embed origin; Vidstack itself is bundled and loads no external script.

## 1. Context

The annotation app embeds a single YouTube video per `ThreadView` and draws its own `TransportBar` over it. We want a "clean" player: no YouTube **top title/share bar**, no **"related videos" button**, no **end-screen "more videos" wall**, no **channel watermark** visible during use.

Constraints that drive this decision:

- **Hard constraint (platform):** The YouTube IFrame Player API *cannot* remove that chrome. It is rendered by YouTube inside the cross-origin embed. `rel=0` since 2018 only restricts related videos to the same channel; it does not remove them. (See §7.)
- **Hard constraint (ToS):** Per YouTube's API ToS you "must not display overlays … in front of … or obscure any part of a YouTube embedded player, including player controls," **with an explicit carve-out** for overlays whose purpose is *playback controls or consent* so long as they don't conflict with the player UI. So drawing our own transport controls is permitted; the gray area is covering the title/branding. (See §7.)
- **Project constraint (vibe-coding):** The maintainer wants the most *deterministic, well-documented, large-community, low-maintenance* option — something an AI agent and a human can both reason about reliably. Brittle, undocumented hacks are explicitly out of scope.
- **Architecture constraint (React 19 StrictMode):** In dev, StrictMode double-invokes mount effects (mount → unmount → mount). A player owned by the React tree would be torn down and rebuilt on that cycle, reloading the YouTube iframe. The existing design avoids this by keeping the player **outside** React (module-level detached wrapper, re-parented on mount). We must preserve that.

We audited `aidenlx/media-extended` (the most popular Obsidian media-notes plugin, ~900★) v3 source to see how it gets a clean YouTube view. Findings in §7. Short version: it does **not** use the IFrame embed — it loads the full `youtube.com/watch` page in an Electron `<webview>`, drives the in-page `<video>` element directly, and cleans the page with an injected userscript (CSS against `ytp-*`/`ytd-app` selectors), a CSP/Trusted-Types bypass, and a Firefox user-agent spoof, with Vidstack drawing the visible controls on top. That achieves more removal but is a hand-maintained stack of fragile subsystems — the opposite of our project constraint, and a plausible reason v4 went closed-source.

## 2. Decision

1. **Use Vidstack as the player engine**, created imperatively with **`VidstackPlayer.create()`** from `vidstack/global/player`, instantiated **once** inside the existing module-level singleton (`getPlayer()`), into a **detached wrapper `<div>`** held at module scope.
2. **Do not** mount Vidstack's React `<MediaPlayer>` component in the React tree. The React component would re-introduce the StrictMode teardown problem (constraint above). The vanilla constructor lets the player live outside React, matching the proven pattern.
3. **Keep the public interface unchanged:** `getPlayer()` / `destroyPlayer()` exports and the `Player` facade (`load`, `play`, `pause`, `seekTo`, `getCurrentTime`, `getDuration`, `setPlaybackRate`, `onStateChange`, `getIframeRect`, `wrapper`, `videoId`). All existing call sites and `usePlayer` keep working.
4. **Cover the chrome; do not remove it.** The singleton's injected CSS sets the YouTube **iframe to `pointer-events: none`**, and the app's view (`ThreadView`) overlays our own UI. Consequence: YouTube never receives hover/click, so its *hover-triggered* chrome (top title+share bar, related-on-hover) never appears at all. The *state-driven* overlays (pause "more videos", end-screen) are not removed; they sit visually behind our overlay/`TransportBar`. Vidstack additionally hides the recommendations popup when custom controls are used. (See §7.)
5. **Do not** adopt the media-extended `<webview>` + userscript approach now. It is treated as a **deferred escalation** (§5).

## 3. Consequences

**Positive**
- React-19-native, TypeScript-first, actively maintained, large community and docs → fits the vibe-coding constraint; an agent can find correct examples.
- Removes the `youtube-player` + `sister.js` cast hacks (the `on`/`off` token casting, the 640×390 stamping) documented in the old `playerSingleton.ts`.
- The clean look does **not** depend on YouTube's internal DOM class names, a UA spoof, or a CSP bypass → no fragile-selector maintenance tax (this is the main reason it beats the webview route for us).
- Provider-agnostic: adding Vimeo / local files / HLS later is a `src` change, not a rewrite.

**Negative / accepted trade-offs**
- The chrome still *exists* underneath. The pause "more videos" overlay and end-screen are covered, not gone; edge cases (e.g. a brief flash, or peek-through if our overlay has gaps) are possible. If this becomes intolerable, escalate (§5).
- Covering the title/branding with an opaque overlay is the **same ToS gray zone** as every approach here — the controls overlay is permitted; obscuring branding is not strictly compliant. Acceptable for a private/solo tool; revisit before any public distribution.
- `VidstackPlayer.create()` is **async**; the singleton facade must bridge an async creation to a (mostly already-async) method surface (see §6).
- Vidstack's YouTube provider chooses its own embed host (`youtube.com` vs `youtube-nocookie.com`) via its `cookies`/`noCookie` option; `vidstack@1.15.2` was observed to use the nocookie host. We widened CSP to allow both (§0) so a future default change can't break the embed.

**Neutral**
- Default media loading strategy is `'visible'` (IntersectionObserver). Because our wrapper starts detached and is re-parented into a custom scroll container, we set `load: 'eager'` to avoid the observer never firing. Documented in code.

## 4. Alternatives considered

- **video.js (+ `videojs-youtube`).** Rejected. Older API, less React-19-native, the YouTube plugin is less maintained, and it *also* wraps the IFrame API (same chrome ceiling). Vidstack brands itself as the modern alternative to Video.js; for our stack it is strictly the better fit.
- **Vidstack React `<MediaPlayer>` mounted in the tree.** Rejected as the *primary* mechanism. Cleaner JSX, but it lives in the React tree → StrictMode teardown reloads the iframe, defeating the singleton's purpose. (We still use Vidstack — just via the vanilla constructor.)
- **media-extended approach: Electron `<webview>` loading `youtube.com/watch` + injected userscript.** Rejected for now, kept as escalation (§5). It removes more chrome and gives true `<video>` control, but requires: maintaining CSS selectors against YouTube's DOM, a Trusted-Types/CSP bypass to inject, a Firefox UA spoof to dodge bot detection, and Electron's **officially discouraged** `<webview>` tag. High maintenance + fragility = fails the project constraint.
- **Stay on `youtube-player` (sister.js).** Rejected. Keeps the cast hacks and gives no path to a clean overlay framework; we'd be hand-rolling what Vidstack already provides.

## 5. Escalation path (only if needed)

If the covered-but-present pause/end-screen chrome proves unacceptable in daily use, escalate to a webview-backed custom Vidstack provider (the media-extended pattern), in this order, smallest step first:

1. First try tightening the overlay: full-bleed cover on `paused`/`ended` states (drive these from `player.subscribe`), so nothing peeks through.
2. Only if that's insufficient: implement a custom Vidstack provider loader backed by an Electron `WebContentsView` (preferred over `<webview>`, which Electron discourages) that loads the watch page and drives the in-page `<video>`. Budget for ongoing YouTube-DOM-selector maintenance and a UA workaround. Re-open this ADR before doing so.

## 6. Implementation notes

- **Creation:** `await VidstackPlayer.create({ target: wrapperEl, load: 'eager', playsInline: true })` — **no `layout`** option (omitting it means no Vidstack default UI; the view renders its own overlay/`TransportBar`). `target` is passed as the **element** (not a selector) because the wrapper is detached and a selector wouldn't resolve in `document`.
- **Source:** set per-video via the instance property `player.src = 'youtube/<id>'` (the `youtube/<id>` shorthand is what Vidstack's YouTube provider expects; full watch URLs also work).
- **Control mapping (instance API):** `play()` / `pause()` are methods; seek is `player.currentTime = seconds`; rate is `player.playbackRate = n`; reads come from `player.state.currentTime` / `player.state.duration`.
- **State:** `player.subscribe((state) => …)` returns an unsubscribe fn and fires on any state change without triggering React renders. We derive the legacy `PlayerState` union (`unstarted | cued | buffering | playing | paused | ended`) from Vidstack's `ended / playing / waiting / started / canPlay / paused` booleans. The `unstarted` vs `cued` vs `buffering` boundary is an approximation of YouTube's discrete codes — documented at the mapping site.
- **StrictMode reconciliation:** the singleton holds `wrapper` (module scope) and an `instance` facade; `getPlayer()` returns the existing instance on re-entry. `usePlayer` (and `ThreadView` on a layout switch) only **re-parents** the wrapper into the view container and never destroys it on unmount. `destroyPlayer()` is for app teardown / tests only.
- **Iframe styling:** a one-time `<style>` scoped by `#yt-player-wrapper` forces the iframe to fill and sets `pointer-events: none`. This avoids assuming a CSS framework (no Tailwind dependency) and removes the need to observe the iframe's async creation.

## 7. Verifiable facts (with sources)

Primary sources (check these directly):

- **Vidstack YouTube provider uses the IFrame API and hides the recommendations popup with custom controls; a `cookies`/`noCookie` option controls the embed host (`youtube.com` vs `youtube-nocookie.com`).** https://vidstack.io/docs/player/api/providers/youtube/
- **Vidstack player instance API** — `play`, `pause`, `subscribe`, `state`, `remoteControl` (Instance table); `currentTime`, `playbackRate`, `src`, `paused`, `muted`, `volume` as props; full state list incl. `ended`, `playing`, `waiting`, `started`, `canPlay`, `duration`, `currentTime`. https://vidstack.io/docs/player/components/core/player/
- **State subscription** — `useMediaState`/`useMediaStore` (re-render) vs `player.subscribe` (no re-render). https://vidstack.io/docs/player/core-concepts/state-management/
- **`VidstackPlayer.create({ target, src, layout })` and import from `vidstack/global/player`** — the vanilla API ships on the Vidstack **1.x line** (npm `next` dist-tag; `latest` is the legacy 0.6.x). Verified locally against `vidstack@1.15.2` (`node_modules/vidstack/global/player.d.ts`: `VidstackPlayer.create(config): Promise<MediaPlayerElement>`). https://github.com/vidstack/player/discussions/1220 and https://github.com/vidstack/player/issues/1238
- **YouTube ToS: overlay prohibition + playback-controls/consent carve-out.** https://developers.google.com/youtube/terms/required-minimum-functionality and https://developers.google.com/youtube/terms/developer-policies-guide
- **Electron officially discourages the `<webview>` tag** (architectural instability; suggests iframe / WebContentsView). https://www.electronjs.org/docs/latest/api/webview-tag/

Secondary source (a source-code audit of the `aidenlx/media-extended` **v3** branch, `apps/app/src/…`) — verify against the branch if any of these become load-bearing:

- YouTube renders through a custom **`WebviewProviderLoader`** built on an Electron **`<webview>`** (not the IFrame API); the in-page `<video>` element is driven directly over a `MessageChannel`. (`lib/remote-player/loader.ts`, `provider.ts`, `hook/handler-register.ts`)
- The clean look uses an **injected userscript** (`web/userscript/youtube.ts`) that force-enables theater mode and z-indexes `#movie_player` to max; it explicitly hides `html5-endscreen` and (conditionally) `ytp-chrome-bottom`, but does **not** target `ytp-chrome-top` (title/share), the pause "more videos" overlay, or the watermark.
- Injection requires a **Trusted-Types policy / CSP workaround**, and the webview uses a **Firefox user-agent spoof** (`lib/remote-player/ua.ts`) to avoid bot detection.
- media-extended is **per-view** (a fresh player + webview per leaf, only the login partition persists) — i.e. *not* a singleton; our singleton is a deliberate divergence suited to a single pinned player.
