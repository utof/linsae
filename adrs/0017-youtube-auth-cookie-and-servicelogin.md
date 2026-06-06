# 0017 — YouTube authentication via cookie-import and a ServiceLogin sign-in window

## Status

Accepted (2026-06-03)

## Context

The webview player (ADR 0016) loads the real `youtube.com/watch` page in an Electron
`<webview>` on the `persist:yt-player` partition. Two problems turned out to share one root
cause — **session trust**:

- **Far-seek goes black.** Seeking into an un-buffered region requests a media segment that
  YouTube's SABR backend withholds without a valid PoToken (`STREAM_PROTECTION_STATUS`). A
  weak/low-trust session mints a weak token, so the segment never arrives and the `<video>`
  stalls at `readyState:1` forever.
- **Cold-partition home-bounce.** A cold, anonymous partition bounces `/watch` to the YouTube
  home via a client-side `history.pushState`.

An **authenticated** session is the highest-trust state YouTube recognises and empirically
clears both. (Per the research, login does not *formally* exempt PoToken — only Premium does —
but in practice an authenticated session raises trust enough that the in-page BotGuard mints a
token the backend accepts.) So we need a way to put the user's real Google session into the
`persist:yt-player` partition. Google blocks signing in inside an embedded `<webview>`, and its
modern `/v3/signin` (GlifWebSignIn) flow rejects an Electron window as "this browser or app may
not be secure" even with a clean Chrome UA.

## Decision

Provide **two complementary, opt-in auth paths**, both seeding the same `persist:yt-player`
partition; if one fails (e.g. Google heuristically flags the account on the window flow) the
other covers it:

1. **Cookie import** (`src/main/yt-cookies.ts`). Parse a Netscape `cookies.txt` exported from
   the user's real browser and `session.cookies.set` each cookie into the partition (yt-dlp's
   `--cookies-from-browser` shape). Key auth cookies: `__Secure-1PSID/3PSID`, `SID/HSID/SSID`,
   `SAPISID`/`__Secure-1PAPISID`/`__Secure-3PAPISID`.

2. **In-app sign-in window** (`openYoutubeLoginWindow` in `src/main/index.ts`). A dedicated
   top-level `BrowserWindow` (not a `<webview>`) that loads the **legacy**
   `accounts.google.com/ServiceLogin?service=youtube` page **directly** — bypassing the gated
   `/v3/signin` flow — using the **default** UA (no spoofing). This is what ytmdesktop and
   th-ch/youtube-music ship in 2026.

Shared safeguards:

- **Skip-if-authed guard.** The importer no-ops when the partition already has `__Secure-3PSID`,
  so it never clobbers live, server-refreshed session cookies (which would invalidate the
  session).
- **No UA spoofing for login.** UA / User-Agent Client Hint spoofing cannot be made consistent
  in Electron (`setUserAgent` sets only the string; `Sec-CH-UA` brands stay "Chromium"-only and
  `navigator.userAgentData` can't be patched under `contextIsolation`), so the login window uses
  the default UA on `accounts.google.com`. The *player* webview keeps its Firefox-95 UA (ADR
  0016) via the `useragent` attribute — independent of the login window.

## Alternatives

- **Embedded `<webview>` login** — blocked by Google ("browser may not be secure").
- **`/v3/signin` flow in a top-level window** — also rejected ("not secure"); reproduced live.
- **UA / client-hint spoofing** — dead end in Electron (electron#34481 brands="Chromium" only,
  electron#34762 high-entropy hints never sent). Both reference apps deliberately use the
  default UA on `accounts.google.com`.
- **OAuth (loopback / device flow)** — yields API bearer tokens, not a `youtube.com` *cookie*
  session, and YouTube's InnerTube only accepts those from the TV client; cannot authenticate a
  webview. Rejected.
- **`youtube-nocookie.com` embed** — the privacy iframe; the rejected iframe architecture (thin
  postMessage API, unhideable chrome) and the wrong axis (fewer cookies, not more trust).

## Consequences

- In-app login works with no manual cookie export; cookie-import remains the reliable fallback.
- Cookies can rotate/invalidate over time. If the session goes logged-out, re-sign-in via the
  window, or re-export cookies from a **closed incognito** window (a live browser rotates and
  invalidates an export).
- The ServiceLogin page shows YouTube **Music** branding (`ltmpl=music`, the proven variant) —
  cosmetic; it logs into the same Google account and sets the same youtube.com cookies.
- Login is currently env-gated (`YT_LOGIN=1`, with a `YT_LOGOUT=1` dev switch that clears only
  local partition storage). Follow-ups: a Settings "Sign in / Sign out / replace cookies" UI,
  and optional automatic Firefox `cookies.sqlite` import (`#61`).

## Sources

- ytmdesktop / th-ch/youtube-music — current `main` loads `accounts.google.com/ServiceLogin?...`
  for sign-in; th-ch ships UA override off by default and restores the real UA on
  accounts.google.com.
- electron/electron#34481 (UA-CH brands = "Chromium" only), #34762 (high-entropy hints broken),
  #9529 (re-parenting destroys the guest), #22346 ("browser may not be secure" — out of
  Electron's control) → https://security.googleblog.com/2019/04/better-protection-against-man-in-middle.html
- yt-dlp #14390 and `yt_dlp/cookies.py` (SABR/PoToken; Firefox `cookies.sqlite` extraction).
- ADR 0016 (webview player), ADR 0012 (Player interface).
