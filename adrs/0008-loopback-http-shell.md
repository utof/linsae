# 0008 — Loopback HTTP shell for the renderer (YouTube-embed origin)

## Context
v0.2 embeds YouTube via the IFrame Player API. Plan 2 served the production
renderer over an `app://bundle` custom scheme (privileged: `standard + secure +
supportFetchAPI`) on the assumption — from the research doc's §5 Risk register
R3 and its "YouTube ToS" note — that a privileged `app://` origin behaves like
`http://localhost` and therefore avoids **YouTube Error 153** (the "video player
configuration error" that hits custom schemes lacking a valid HTTP referrer /
origin, e.g. Tauri's `tauri://localhost`, per tauri-apps/tauri#14422).

That assumption was never tested against a live embed: `scripts/capture-smoke.mjs`
captured with `videoId: 'smoke-test'` and never loaded a YouTube iframe. Three
automated Playwright `_electron` spikes against the built app disproved it:

- **app:// + `referrerpolicy`** → `ERROR:153` (and a `postMessage` warning that the
  target origin did not match the recipient origin `app://bundle`).
- **app:// + main `webRequest` `Referer: https://www.youtube.com/` injection** →
  `153` became `ERROR:152` (still blocked) — including for known-embeddable videos
  (`M7lc1UVf-VE`, `jNQXAC9IVRw`), `getDuration() = 0`, never cued.
- **`http://localhost` (real Electron, real CSP, same videos)** → reached
  `state:5`→`1`, `getDuration` 1344/19, `seekTo` worked, **zero errors**.

Root cause: YouTube validates the embedding origin via `ancestorOrigins`/postMessage,
which reflects the real `app://bundle` document origin — not fixable by HTTP-header
injection. Only an `http(s)`/`localhost` origin is accepted.

## Decision
Serve the production renderer over a **loopback `http://127.0.0.1:<port>` HTTP server**
in the main process, instead of `app://bundle`. A `node:http` server (`src/main/
http-shell.ts`, `startLoopbackShell`) binds `127.0.0.1` on an ephemeral port, serves
GET requests for the built renderer (`out/renderer`) and the `/_media/` attachment
route, and reuses the existing pure `resolveAppRequest` path-resolver + traversal
guard (kept in `app-protocol.ts`, now electron-free). The window loads
`http://127.0.0.1:<port>/`. `_media` becomes same-origin, so `mediaUrlFromPath`
emits a relative `/_media/<yyyy>/<mm>/<sha>.png` and the CSP `app:` `img-src` token
is dropped; dev (already `http://localhost` via the vite server) proxies `/_media`
to the same shell started on a fixed `DEV_MEDIA_PORT`. The `app://` scheme + handler
are retired. No `Referer`/`Origin` rewriting is needed (a bare loopback origin works);
`host: youtube-nocookie` + `referrerpolicy="strict-origin-when-cross-origin"` on the
player iframe are kept (harmless, policy-aligned).

Security baseline (single-user local app): bind `127.0.0.1` only (never `0.0.0.0`),
ephemeral port, **GET-only** (405 otherwise), the traversal guard (400 on escape),
**no** `Access-Control-Allow-Origin`, a NUL-byte request guard (400, avoids a
`createReadStream` synchronous-throw main crash), and `X-Content-Type-Options:
nosniff` on every response. No mutating endpoints exist (all writes stay on the
contextIsolated preload/IPC bridge). Validated end-to-end by the updated
`scripts/capture-smoke.mjs`, which asserts the document origin is `http://127.0.0.1`
and the embed reaches cued/playing with no `ERROR:153/152/101`.

## Alternatives
- **`app://` + main `webRequest` `Referer` injection** — tested; only moved 153→152.
  The origin (not the referrer) is the block; rejected.
- **Player in a `youtube-nocookie.com`-origin `WebContentsView` overlay** — keeps
  `app://`; embed origin is youtube's own. Rejected for v0.2: a much larger
  player-subsystem + capture-path redesign (capturePage from a separate WebContents,
  overlay geometry sync) for no benefit over the loopback shell. Revisit only if the
  loopback footprint proves unacceptable.
- **Hybrid: keep `app://`, host only the player iframe under a nested
  `http://localhost` document** — adds cross-origin postMessage plumbing for marginal
  benefit; rejected.
- **Path-token prefix hardening** (`/<token>/…`) — the renderer build `base` is the
  default absolute `/`, so a token would have to thread through every absolute asset
  URL + index.html + the dev proxy for negligible gain (`_media` is sha256-named,
  non-enumerable, no directory listing; the bundle is app code). Deferred to a `nit`
  hardening issue; port-only ships.

## Consequences
- The embed works in production; the dev/prod image story unifies (same-origin
  `/_media`), dissolving the earlier app://-vs-localhost cross-scheme problem.
- A loopback server is reachable by other local processes that learn the port, but
  it is `127.0.0.1`-bound, GET-only, serves only the bundle (not secret) and
  sha256-named `_media` (non-enumerable, no listing), and sends no CORS header — so a
  port-scanner cannot enumerate attachments or write anything. Residual hardening
  (path-token, `EADDRINUSE` dev-port retry) is filed as `nit` issues.
- `webSecurity` stays at its secure default (a real http origin is a better fit than
  a custom scheme); preload/contextIsolation/sandbox are unaffected.
- This supersedes the `app://`-document decision; `app-protocol.ts` survives only as
  the shared `resolveAppRequest` resolver reused by the shell.

## Sources
- `docs/specs/v0.2-localhost-shell.md` (problem table, the 4 spikes, §7 review revisions).
- tauri-apps/tauri#14422 — Error 153 under `tauri://localhost` (custom-scheme referrer).
- Simon Willison, "YouTube embed 153 error" — https://simonwillison.net/2025/Dec/1/youtube-embed-153-error/
- YouTube IFrame Player API — https://developers.google.com/youtube/iframe_api_reference
- Electron `protocol.registerSchemesAsPrivileged` / `protocol.handle` — https://www.electronjs.org/docs/latest/api/protocol
