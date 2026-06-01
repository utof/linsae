# 0016 — Webview-backed YouTube player (clean watch-page embed)

- **Status:** Accepted
- **Date:** 2026-06-01
- **Supersedes:** ADR 0015 (Vidstack-over-IFrame). The singleton architecture and `Player` interface from ADR 0012 are kept unchanged. The *engine* changes from Vidstack + IFrame API to a `<webview>` loading `youtube.com/watch` driven over a `MessagePort` RPC.
- **Applies to:** `src/renderer/src/yt/playerSingleton.ts` (engine rewrite), `src/renderer/src/yt/rpc.ts` (new), `src/renderer/src/yt/inject/youtube-guest.ts` (new), `src/renderer/src/yt/inject/clean-css.ts` (new), `src/main/security.ts` (webviewTag), `src/main/index.ts` (will-attach-webview guard).

> This ADR is written to be auditable by a coding agent. Claims that an agent can independently verify are collected in **§6 Verifiable facts (with sources)**. If any turn out false, treat the surrounding decision as suspect.

---

## 1. Context

ADR 0015 §5 named the `<webview>` + watch-page approach as "the escalation path (only if needed)" and required re-opening the decision first. After several weeks of daily use, the covered-but-present YouTube chrome (pause "more videos" overlay, end-screen, title/share bar) remained unacceptable. The ADR 0015 §5 trigger has fired; this ADR records the escalation.

**Root cause:** The YouTube IFrame Player API cannot remove the chrome that YouTube renders inside the cross-origin embed. `rel=0` (ADR 0015 §1) restricts related-video suggestions but does not remove them. Overlaying the iframe with our own `TransportBar` (ADR 0015 §2) prevents hover-triggered chrome from appearing, but the state-driven overlays (pause wall, end-screen) still exist underneath, visible through gaps or flashes.

**Escalation trigger (ADR 0015 §5, smallest step first):**
1. *Tighten the overlay (full-bleed cover on paused/ended states)* — tried first. Eliminated most peek-through but could not eliminate all edge cases without making the overlay opaque full-time (which defeats the purpose of watching the video).
2. *Implement a `<webview>` + watch-page approach* — this ADR.

The Task-1 spike (branch `v0.2.1/ux-animation-fixes`) confirmed the unverified claim from §0 of the spec: host→guest `MessagePort` transfer via `webview.contentWindow.postMessage(nonce, '*', [port])` works on our Electron 39 + `secureWebPreferences` setup. The smoke (Task T7) confirmed non-black `capturePage(rect)` captures for the `<webview>` element, matching the existing IFrame result (spec §0 row 2).

## 2. Decision

Ten decisions constitute this milestone (D1–D10). Each is binding and may only be reversed by opening a new ADR.

**D1 — `<webview>`, not `WebContentsView`.**
`WebContentsView` is a native view positioned by main-process pixel bounds; it composites *above* the DOM (our `TransportBar`/overlay cannot sit on top) and requires per-frame `setBounds` IPC synchronized to scroll/resize (jank). `<webview>` is a DOM element that fits the existing 16:9 box without layout IPC, re-parents with the detached wrapper (ADR 0012 pattern), and lets our overlay/controls use normal `z-index`. Trade-off: `<webview>` is Electron-discouraged (§6 source 1); we isolate it entirely behind the `Player` facade so a future swap is localized to `playerSingleton.ts`.

**D2 — Drop Vidstack; drive the in-page `<video>` directly.**
The app owns its own `TransportBar`; Vidstack's UI layer is dead weight. Vidstack's custom-provider contract is internal/undocumented and requires a live DOM target. Removing `vidstack` eliminates a transitive dep without losing any rendered surface. The `<video>` API (`play()`, `pause()`, `currentTime`, `playbackRate`, `muted`, events) is stable web-standard (§6 source 3).

**D3 — `Player` facade and `getMediaRect()` return shape unchanged (ADR 0012 preserved).**
`getPlayer()` / `destroyPlayer()` exports, the `Player` interface (`load`, `play`, `pause`, `seekTo`, `getCurrentTime`, `getDuration`, `setPlaybackRate`, `onStateChange`), and the extra singleton members (`wrapper`, `videoId`, `getMediaRect()`) have the same signatures. `getIframeRect` was renamed `getMediaRect` in the same milestone (mechanical fan-out to `ThreadView.tsx` and test files). All call sites compile without further changes.

**D4 — Singleton + detached wrapper + re-parent (ADR 0012 pattern unchanged).**
`getPlayer()` constructs the wrapper `<div id="yt-player-wrapper">` + `<webview>` + loading cover + click-catcher once; subsequent calls return the existing instance. `destroyPlayer()` is for app teardown and test cleanup only. `usePlayer` re-parents the wrapper into the view container on mount; it never destroys it on unmount. This keeps React 19 StrictMode's double-mount cycle from reloading the YouTube page.

**D5 — `capturePage(rect)` pipeline unchanged (ADR 0009 preserved).**
The renderer reads `getMediaRect()` (the `<webview>` element's `getBoundingClientRect()`) and passes the rect to the existing `api.youtube.capture({rect, videoId, t})` IPC. Main does `win.webContents.capturePage(rect)` exactly as before. No schema, IPC, Zod, or preload change. The Task-T7 smoke confirmed non-black captures of the webview region.

**D6 — UA spoof + persistent partition + autoplay user-gesture.**
`webview.setUserAgent(desktopFirefoxUA())` strips `Electron`/app tokens to avoid YouTube's bot/unsupported-browser treatment. `partition="persist:yt-player"` so a one-time sign-in/consent survives across restarts. Programmatic `play()` is preceded by `await webview.executeJavaScript('1', true)` (the `userGesture=true` flag grants browser activation for `video.play()` — §6 source 4). Adapted from `aidenlx/media-extended` `provider.ts:120`.

**D7 — Inject control runtime via `executeJavaScript`, CSS via `insertCSS`; no preload, no eval, no CSP strip.**
`executeJavaScript(code)` runs in the page's main world and can read `window`/`<video>`/`ytInitialPlayerResponse`; it is not a Trusted-Types `<script>` injection sink, so it never needs `unsafe-eval` or a TT policy (§6 source 2). `insertCSS` is TT-exempt. No guest `preload` script (Electron-discouraged for webview; adds a file:// dep). No `unsafe-eval` CSP widening.

**D8 — `will-attach-webview` security guard is part of this milestone.**
`app.on('web-contents-created')` handles `will-attach-webview`: clamp `webPreferences.nodeIntegration=false`, `contextIsolation=true`, `sandbox=true`, delete any unexpected `preload`; `preventDefault` for non-`youtube.com` attach attempts. Guest `will-navigate` and `setWindowOpenHandler` confine navigation to `*.youtube.com` and deny popups. This restores the hardened-baseline security posture before enabling `webviewTag:true` in `secureWebPreferences` (§6 source 5).

**D9 — Guest runtime is a hand-authored self-contained JS string.**
`src/renderer/src/yt/inject/youtube-guest.ts` exports a function that returns an IIFE string; injected via `executeJavaScript`. This sidesteps the electron-vite/rolldown "bundle-an-IIFE-and-exclude-from-react-compiler-babel" problem (plan reviewer finding). Trade-off: the guest code is not type-checked by `tsc`; it is small (~230 lines), isolated to one file, and covered end-to-end by the `thread-smoke.mjs` smoke. If it outgrows a string constant, revisit a rollup sub-entry (deferred follow-up issue).

**D10 — Attribution.**
`inject/youtube-guest.ts`, `inject/clean-css.ts`, `rpc.ts`, and `ua.ts` derive from `aidenlx/media-extended` v3 (MIT © 2024 AidenLx, PKM-er). Each file carries `Adapted from aidenlx/media-extended (MIT) — <upstream path>` and the MIT notice is retained. A `NOTICES` entry will be added on public distribution.

## 3. Alternatives considered

**`WebContentsView` (main process native view).** Rejected. It composites *above* the BrowserWindow DOM, meaning our `TransportBar` and overlay divs cannot sit on top of it without a second `BrowserWindow` layer. Every resize/scroll requires a main-process `setBounds` IPC call to reposition it — framerate-coupled to Electron's IPC round-trip. The existing `z-index`-based overlay model requires a DOM-composited element, which `<webview>` provides and `WebContentsView` does not.

**Vidstack custom YouTube provider backed by `<webview>`.** Rejected. Vidstack's provider contract (`Provider` class, `MediaProviderAdapter`, `AnyMediaElement`) is internal and undocumented; the maintainers explicitly state it is not a public API. Coupling to it means any Vidstack minor release can silently break the integration, and diagnosing it requires reading Vidstack's source. Since the app owns its own `TransportBar` and no Vidstack UI is visible, there is no benefit to keeping Vidstack in the dep graph. Removing it produces a simpler, directly-maintained stack.

**Stay on Vidstack + IFrame API with full-bleed covers.** Rejected (this is the ADR 0015 §5 step 1 attempt). A full-bleed black cover on `paused`/`ended` states eliminates peek-through but creates a new problem: the cover must track player state precisely or it obscures the video frame itself. The state machine required to do this correctly is more complex than the webview engine, with no clean escape hatch if it fails.

## 4. Consequences

**Positive**
- The YouTube chrome (title/share bar, end-screen, related-video overlay, pause wall, watermark, control bar) is hidden by `insertCSS(CLEAN_CSS)` + the `mx-ready` class gate. Only the in-player ad module and Skip-Ad button are deliberately preserved (§4.4 of spec — hiding them would trap the user in an unskippable ad).
- The `Player` facade is unchanged — `usePlayer`, `ThreadView`, `TransportBar`, timestamp-seek, and duration write-back require zero changes beyond the mechanical `getIframeRect`→`getMediaRect` rename.
- The capture pipeline is unchanged — proven non-black PNG captures continue to work via `capturePage(rect)`.
- The skip-ad button is interactive because only the chrome CSS is hidden; the in-player ad layer is preserved.
- Persistent partition: a one-time manual sign-in or consent-wall dismiss survives across sessions.

**Negative / accepted trade-offs**
- `<webview>` is Electron-officially-discouraged (§6 source 1) and may be removed or broken in a future Electron major. Mitigated by: isolation behind the `Player` facade; `will-attach-webview` guard; an ADR-0016 escape hatch comment in `playerSingleton.ts`.
- YouTube DOM churn: `youtube-guest.ts` contains CSS selectors (`#movie_player`, `.ytp-chrome-bottom`, `.html5-endscreen`, `ytd-consent-bump-v2-lightbox`, `.ytp-size-button`) that are coupled to YouTube's internal DOM. YouTube changes these without notice. All coupling is concentrated in two files (`inject/youtube-guest.ts` and `inject/clean-css.ts`), each selector is commented, and `webview.openDevTools()` is available behind a dev flag for maintenance.
- In-stream ads play (not hidden, not auto-skipped — v1 accepted limitation). Follow-up issue open for ad-skip heuristic.
- ToS gray zone: hiding YouTube's chrome and driving the watch page directly is not the IFrame API's intended use. Acceptable for a private/solo tool; revisit before public distribution.
- Consent/bot wall: a fresh `persist:yt-player` partition may show a consent wall that requires a manual one-time dismiss. The `needs-interaction` RPC event drops the click-catcher so the user can interact; the persistent partition remembers the decision.
- Guest code is not type-checked (`D9`). Risk is bounded by the file's isolation and the end-to-end smoke.

**Neutral**
- The singleton + detached-wrapper + re-parent pattern is unchanged (ADR 0012). No StrictMode reload risk.
- The host-window `capturePage(rect)` mechanism composites the webview exactly as it composited the iframe — no DRM/GPU path change.

## 5. Escalation path

If `<webview>` is removed or broken in a future Electron major: the `MessagePort` RPC protocol is wire-identical to the `MessagePortMain` + `WebContents.postMessage` path (§6 source 6). The migration is: move port creation into the main process (`MessagePortMain`), transfer the host end over `WebContents.postMessage`, and load the watch page in a `WebContentsView`. The guest-runtime string and `clean-css` string are unchanged. Budget 2–3 days of layout work for the `WebContentsView` Z-order problem (host controls must remain on top — a floating `BrowserView`-style window is the known workaround).

## 6. Verifiable facts (with sources)

1. **`<webview>` Electron 39: supported but discouraged; `webPreferences.webviewTag`; attributes `src/useragent/partition/preload(file://)/webpreferences`; methods `executeJavaScript(code,userGesture)` (main world), `insertCSS`, `setUserAgent`, `openDevTools`; events `dom-ready/did-start-loading/did-fail-load/will-navigate`.** `contentWindow` is NOT in Electron's docs (hence the Task-1 spike gate in the spec). — https://www.electronjs.org/docs/latest/api/webview-tag

2. **`executeJavaScript` runs in the page main world; `executeJavaScriptInIsolatedWorld` for the isolated variant. Not a Trusted-Types `<script>` sink; TT exempts JS injection via devtools-protocol paths.** — electron/electron#14288; https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/require-trusted-types-for

3. **`HTMLVideoElement` API — `play()`, `pause()`, `currentTime`, `playbackRate`, `muted`, `ended`, `paused`, events `play/pause/playing/waiting/canplay/seeked/durationchange/ended/loadedmetadata/timeupdate` — web-standard, stable 5+ years.** — https://developer.mozilla.org/en-US/docs/Web/API/HTMLVideoElement

4. **Autoplay: muted always autoplay; unmuted needs user activation; `executeJavaScript(code, true)` grants activation in the webview's renderer process.** — https://www.chromium.org/audio-video/autoplay/

5. **Security: `will-attach-webview` guard; clamp webPreferences before attach; guest will-navigate confinement; setWindowOpenHandler.** — https://www.electronjs.org/docs/latest/tutorial/security (§verify-webview-options)

6. **`MessagePortMain` + `WebContents.postMessage` for main-process port transfer (documented fallback if `contentWindow.postMessage` were to fail).** — https://www.electronjs.org/docs/latest/tutorial/message-ports

7. **`win.webContents.capturePage([rect])` → `NativeImage.toPNG()`, compositor-level, proven non-black for both the IFrame (ADR 0015 smoke) and the `<webview>` (Task-T7 smoke, this branch).** — https://www.electronjs.org/docs/latest/api/web-contents#contentsCapturepagerect

8. **media-extended v3 (MIT © 2024 AidenLx, PKM-er): webview `contentWindow` hand-type (`components/webview/index.tsx:17`), UA spoof (`lib/remote-player/ua.ts`), port transfer (`provider.ts:185`), userGesture (`provider.ts:120`), userscript CSS + consent detect (`web/userscript/youtube.ts`).** — https://github.com/aidenlx/media-extended/tree/main (v3 branch; audited locally at `/tmp/media-extended-v3`).

9. **Electron officially discourages `<webview>` (architectural instability; suggests `<iframe>` / `WebContentsView`).** — https://www.electronjs.org/docs/latest/api/webview-tag/
