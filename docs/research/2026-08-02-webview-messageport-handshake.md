# Electron `<webview>` MessagePort handshake — research for #213 and #211

**Date:** 2026-08-02
**Scope:** `src/renderer/src/yt/` — the host↔guest MessagePort RPC that drives the YouTube player.
**Target runtime (verified locally):** `electron@42.5.0` → Chromium `148.0.7778.271`, Node `v24.17.0`
(`node_modules/electron/package.json`; `electron/electron` `DEPS` at tag `v42.5.0`).
**Status:** research only. No source file was modified.

---

## Verdict

- **`webview.contentWindow.postMessage(msg, '*', [port])` is sound.** It is not deprecated and not
  removed: Electron 42.5.0 defines `contentWindow` itself in
  [`lib/renderer/web-view/web-view-impl.ts:49-55`](https://github.com/electron/electron/blob/v42.5.0/lib/renderer/web-view/web-view-impl.ts#L49-L55)
  and depends on it internally for `WebViewElement.prototype.focus` (`:206-208`). It is undocumented
  and absent from `electron.d.ts` (we declare it ourselves at `playerSingleton.ts:39`), and Electron
  has no spec coverage for messaging through it — but **#213 is not an "wrong API" bug.** Do not
  rewrite the transport.
- **`dom-ready` fires once per committed main-frame document — so it fires many times per webview,
  and a document swap kills the injected runtime every time.** That makes `if (rpc || !wv) return`
  (`playerSingleton.ts:176`) wrong in the *steady state*, not only in a race.
- **#213's mechanism is right but its window is far too narrow.** The issue frames the race as the
  gap between `await safeExec(...)` (`:190`) and `wv.contentWindow.postMessage(...)` (`:192`) — tens
  of milliseconds. The dominant failure is much wider: the **entire lifetime of the first document**.
  If the first `dom-ready` belongs to a consent/interstitial/redirect document, the runtime is
  injected *there*, `rpc` latches, and every later `dom-ready` — including the real watch page — is
  refused. The repo's own smoke already says exactly this at `scripts/thread-smoke.mjs:841-846`.
- **The issue's suggested fix is necessary but not sufficient.** "Assign `rpc` only after the port
  transfer is acknowledged" fixes the half-built case. It does not fix the *fully acked* case: an
  rpc built on document A stays non-null and healthy-looking after A is replaced, while the guest
  endpoint died with A. The fix must **invalidate on navigation**, not merely on failure.
- **`rpc.whenReady()` cannot be the acknowledgement signal, for two independent reasons.** (a) The
  guest only calls `rpc.ready()` from `attachVideo()` (`inject/youtube-guest.ts:155`), which requires
  `ytd-app #movie_player video` to exist — so it means "a video was found", not "the port landed",
  and it never fires on a consent page. (b) `Promise.race([rpc.whenReady(), timeout(10000)])`
  (`:197`) **discards the race result**, so a 10 s timeout and a real ack are indistinguishable to
  the caller.
- **#211's minimal fix is correct but incomplete.** Resetting `cache` in `load()` is right. It must
  *also* reset on any main-frame cross-document navigation (a consent redirect or a YouTube self-
  reload resets the guest without going through `load()`), and the `durationDone` latch in
  `usePlayer.ts:38-45` / `usePlayerState.ts:40-47` should be deleted outright rather than patched —
  it is pure overhead (React bails out on an identical `setDuration` value) and is the thing that
  makes a single stale read permanent.

---

## Q1 — `<webview>` `dom-ready` semantics in Electron 42

### What the public docs say

`docs/api/webview-tag.md` at tag `v42.5.0`, verbatim and complete:

> ### Event: 'dom-ready'
>
> Fired when document in the given frame is loaded.

That is the entire entry. It says nothing about cardinality. Source:
<https://github.com/electron/electron/blob/v42.5.0/docs/api/webview-tag.md>

### What the implementation actually does (authoritative)

`<webview>`'s `dom-ready` is a **1:1 forward of the guest `WebContents`' `dom-ready`**. The forwarding
table is `lib/browser/web-view-events.ts` at `v42.5.0`:

```ts
export const webViewEvents: Record<string, readonly string[]> = {
  'load-commit': ['url', 'isMainFrame'],
  'did-attach': [],
  'did-finish-load': [],
  ...
  'dom-ready': [],
  ...
  'did-start-navigation': ['url', 'isInPlace', 'isMainFrame', 'frameProcessId', 'frameRoutingId'],
  'did-navigate': ['url', 'httpResponseCode', 'httpStatusText'],
  'did-navigate-in-page': ['url', 'isMainFrame', 'frameProcessId', 'frameRoutingId'],
```

<https://github.com/electron/electron/blob/v42.5.0/lib/browser/web-view-events.ts>

Note `'dom-ready': []` — **the event carries no payload at all**. No `url`, no `isMainFrame`. You
cannot tell from the event which document it belongs to; you must read `webview.getURL()` yourself.

The emission point, `shell/browser/api/electron_api_web_contents.cc:2076-2084` at `v42.5.0`:

```cpp
void WebContents::DOMContentLoaded(
    content::RenderFrameHost* render_frame_host) {
  auto* web_frame = WebFrameMain::FromRenderFrameHost(render_frame_host);
  if (web_frame)
    web_frame->DOMContentLoaded();

  if (!render_frame_host->GetParent())
    Emit("dom-ready");
}
```

`DOMContentLoaded` is a `content::WebContentsObserver` override, called **once per committed
document**, and the `!GetParent()` check restricts the emit to the main frame.

### Answer

| Trigger | `dom-ready`? | Guest JS world survives? |
|---|---|---|
| Initial load | **yes** | n/a (created) |
| `src` reassignment (our `load()`, `:306`) | **yes** | **no** — new document |
| HTTP redirect / consent interstitial → watch page | **yes, once per committed document** | **no** |
| Full page reload (YouTube self-reload, crash recovery) | **yes** | **no** |
| YouTube SPA nav (`pushState`, clicking a related video) | **no** | **yes** — same document |

Same-document navigation is handled by the sibling event, per
`electron_api_web_contents.cc:2341-2360`:

```cpp
if (!navigation_handle->IsErrorPage()) {
  auto url = navigation_handle->GetURL();
  bool is_same_document = navigation_handle->IsSameDocument();
  if (is_same_document) {
    Emit("did-navigate-in-page", url, is_main_frame, frame_process_id,
         frame_routing_id);
  } else {
    ...
    Emit("did-frame-navigate", ...);
    if (is_main_frame) {
      Emit("did-navigate", url, http_response_code, http_status_text);
    }
```

### Which event is the correct gate?

**`dom-ready` is the correct *arm* signal** and should stay. It is the earliest point at which the
new document has a DOM to inject into, and `insertCSS`/`executeJavaScript` need `getWebContentsId()`
to be valid (the reason for the existing comment at `playerSingleton.ts:94-99`).

**What is missing is an *invalidate* signal.** The right one is `did-start-navigation` filtered to
main-frame cross-document, because it precedes the commit:

```
did-start-navigation (isMainFrame && !isInPlace)   ← invalidate here
  → did-redirect-navigation*                        (0..n)
  → did-navigate                                    (commit)
  → dom-ready                                       (DOMContentLoaded)  ← arm here
  → did-finish-load                                 (onload)
```

Verified event shape on the **webview** side (this differs from the `webContents` side and is a
classic mis-transcription trap — the webview forwards the *deprecated flat* props):

`docs/api/webview-tag.md` @ `v42.5.0`:
> ### Event: 'did-start-navigation'
> Returns:
> * `url` string
> * `isInPlace` boolean
> * `isMainFrame` boolean
> * `frameProcessId` Integer
> * `frameRoutingId` Integer
>
> Emitted when any frame (including main) starts navigating. `isInPlace` will be `true` for in-page navigations.

Confirmed against the installed typings, `node_modules/electron/electron.d.ts:21202-21208`:

```ts
interface DidStartNavigationEvent extends DOMEvent {
  url: string;
  isInPlace: boolean;
  isMainFrame: boolean;
  frameProcessId: number;
  frameRoutingId: number;
}
```

So on `<webview>` it is **`isInPlace`**, *not* `isSameDocument`. (`webContents`'s modern
`details.isSameDocument` is the other spelling; the webview never got the modernised payload.)

**Do NOT use `will-navigate` as the invalidate signal.** `docs/api/web-contents.md` @ `v42.5.0`:

> Emitted when a user or the page wants to start navigation on the main frame. It can happen when
> the `window.location` object is changed or a user clicks a link in the page.
>
> **This event will not emit when the navigation is started programmatically with
> APIs like `webContents.loadURL` and `webContents.back`.**

Our `load()` sets `webviewEl.src`, which routes through `loadURL` — so `will-navigate` would miss
our own video changes, and it also misses server-side 3xx redirects (those surface as
`did-redirect-navigation`). media-extended does use `will-navigate` for its `domReady` flag
(`apps/app/src/components/webview/index.tsx:69`) and has the same hole.

---

## Q2 — Is `webview.contentWindow.postMessage(msg, '*', [port])` supported?

### Verdict: **undocumented, untyped, but real, current, and used by Electron itself.**

`lib/renderer/web-view/web-view-impl.ts` @ `v42.5.0`, constructor lines 39-56:

```ts
    // Create internal iframe element.
    this.internalElement = this.createInternalElement();
    const shadowRoot = this.webviewNode.attachShadow({ mode: 'open' });
    const style = shadowRoot.ownerDocument.createElement('style');
    style.textContent = ':host { display: flex; }';
    shadowRoot.appendChild(style);
    this.attributes = setupWebViewAttributes(this);
    this.viewInstanceId = getNextId();
    shadowRoot.appendChild(this.internalElement);

    // Provide access to contentWindow.
    Object.defineProperty(this.webviewNode, 'contentWindow', {
      get: () => {
        return this.internalElement.contentWindow;
      },
      enumerable: true
    });
```

And Electron relies on it, `:204-208`:

```ts
export const setupMethods = (WebViewElement: ..., hooks: WebViewImplHooks) => {
  // Focusing the webview should move page focus to the underlying iframe.
  WebViewElement.prototype.focus = function () {
    this.contentWindow.focus();
  };
```

So `<webview>` is a custom element wrapping a shadow-DOM `<iframe>` (`createInternalElement`,
`:58-66`), and `contentWindow` is that iframe's window proxy. Once the guest is attached that proxy
points at an out-of-process frame, and `postMessage(msg, '*', [port])` on it is ordinary cross-origin
frame messaging — Chromium transfers `MessagePort` endpoints across process boundaries natively.

**Stability caveats, stated honestly:**

1. **Not in the docs.** `docs/api/webview-tag.md` @ `v42.5.0` never mentions `contentWindow`.
2. **Not in the typings.** `node_modules/electron/electron.d.ts:19412-20053` (`interface WebviewTag`)
   has no `contentWindow` member — hence our local re-declaration at `playerSingleton.ts:33-40`, and
   media-extended's identical workaround (`apps/app/src/components/webview/index.tsx:17-22`).
3. **Not covered by Electron's own tests.** `spec/webview-spec.ts` @ `v42.5.0` (2374 lines) contains
   zero occurrences of `contentWindow`. Nothing upstream would catch a regression here.
4. **It has been removed before.** [electron#997](https://github.com/electron/electron/issues/997)
   (closed 2015-01-12) — a 2015-09-06 comment reads *"Is there any way to use
   `ContentWindow.postMessage` on a webview now that the `contentWindow` reference has been
   removed?"*, and the maintainer answer was *"I'd just shim it back in"*. It came back with the
   iframe-based rewrite. Treat it as a supported-in-practice, unsupported-on-paper surface — which
   is precisely the ADR 0016 D1 trade-off already accepted ("`<webview>` is Electron-discouraged; we
   isolate it entirely behind the `Player` facade").

### The sanctioned alternatives — and why none of them is available to us

**(a) `ipcRenderer.postMessage` / `webContents.postMessage` / `frame.postMessage`.**
`docs/api/web-contents.md:2049-2060` @ `v42.5.0`:

> #### `contents.postMessage(channel, message, [transfer])`
> * `channel` string
> * `message` any
> * `transfer` MessagePortMain[] (optional)
>
> Send a message to the renderer process, optionally transferring ownership of zero or more
> [`MessagePortMain`][] objects.
>
> The transferred `MessagePortMain` objects will be available in the renderer process by accessing
> the `ports` property of the emitted event. When they arrive in the renderer, they will be native
> DOM `MessagePort` objects.

`docs/api/web-frame-main.md:127-138` is word-for-word the same for `frame.postMessage`.

Both deliver the port to **`ipcRenderer` in the guest**. Our guard forces `sandbox: true`,
`contextIsolation: true`, `nodeIntegration: false` and **deletes any preload** — `src/main/index.ts:276-282`:

```ts
  contents.on('will-attach-webview', (event, prefs, params) => {
    delete prefs.preload
    prefs.nodeIntegration = false
    prefs.contextIsolation = true
    prefs.sandbox = true
```

With no preload and no node integration there is no `ipcRenderer` in the guest at all, so there is
nothing to receive the port. This path is **closed by construction**.

**(b) A guest preload (`preload` attribute / `webpreferences`).** This *is* the documented path.
`docs/tutorial/message-ports.md` @ `v42.5.0`, § "Communicating directly between the main process and
the main world of a context-isolated page":

```js title='preload.js (Preload Script)'
const { ipcRenderer } = require('electron')

// We need to wait until the main world is ready to receive the message before
// sending the port. We create this promise in the preload so it's guaranteed
// to register the onload listener before the load event is fired.
const windowLoaded = new Promise(resolve => {
  window.onload = resolve
})

ipcRenderer.on('main-world-port', async (event) => {
  await windowLoaded
  // We use regular window.postMessage to transfer the port from the isolated
  // world to the main world.
  window.postMessage('main-world-port', '*', event.ports)
})
```

Two observations. First, the last line is **the same primitive we use** — a nonce-gated
`window.postMessage` with a transferred port into a main world. Our design is the documented design;
only the *origin* of the port differs. Second, the comment above it is Electron conceding our exact
class of bug: *"We need to wait until the main world is ready to receive the message before sending
the port."*

Adopting a guest preload requires reversing **ADR 0016 D7** ("Inject control runtime via
`executeJavaScript`, CSS via `insertCSS`; **no preload**, no eval, no CSP strip") and **D8** (the
`will-attach-webview` clamp is *part of* that milestone's security posture). That is a new ADR, not
an inline fix. It buys re-armability but costs the hardened baseline, and it is not needed —
see Q3/Q5.

**(c) `webContents.getAllWebContents()` / `webContents.fromId(id)` to reach the guest from main.**
Both exist and work. `docs/api/web-contents.md` @ `v42.5.0`:

> ### `webContents.getAllWebContents()`
> Returns `WebContents[]` - An array of all `WebContents` instances. This will contain web contents
> for all windows, **webviews**, opened DevTools, and DevTools extension background pages.
>
> ### `webContents.fromId(id)`
> Returns `WebContents | undefined` - A WebContents instance with the given ID, or `undefined` if
> there is no WebContents associated with the given ID.

`webview.getWebContentsId()` gives the id (`electron.d.ts:19730`). But reaching the guest's
`webContents` only lets you call `executeJavaScript` (which we already do from the renderer) or
`postMessage` (which needs a preload, per (a)). It **does not unlock a port path**.

### What our repo currently does — confirmed

- The `<webview>` is created with **no `preload` attribute**: `playerSingleton.ts:228-235` sets only
  `partition`, `webpreferences=autoplayPolicy=user-gesture-required`, `useragent`, and inline styles.
- Guest code is injected **only** via `executeJavaScript` (`safeExec` → `guestRuntime(NONCE)` at
  `:190`; the gesture-carrying `play()` at `:315-318`; `toggleFullscreen()` at `:359-362`), and CSS
  via `insertCSS` (`:100-113`). Consistent with ADR 0016 D7.

---

## Q3 — Direction of the handshake: host-initiated vs guest-initiated

**Guest-initiated is the more robust pattern in general and is naturally re-arming — confirmed. It
is not available to us without reversing ADR 0016 D7.** Here is the reasoning, and the achievable
substitute.

### Why guest-initiated is naturally re-arming

The asymmetry is about *who holds a reference that survives*. A host-initiated handshake pushes a
port into a document the host cannot see the lifetime of; if that document is replaced, the port is
orphaned silently and the host learns nothing. A guest-initiated handshake runs *inside* the document
whose life it is bound to: a new document means new code means a new offer, automatically, with no
host-side liveness tracking at all.

Electron's own documented recipe is guest-initiated in exactly this sense: the preload — code that
re-runs on every document — is what performs the transfer, and it self-sequences against
`window.onload`.

### Why we cannot do it

A guest-initiated handshake needs code that runs on every document *without the host having to
inject it*. That is what a preload is. We have no preload, by ADR 0016 D7, and `src/main/index.ts:277`
actively deletes one if it appears. Without a preload, the only way guest code exists at all is
`executeJavaScript` — a host-initiated act. The handshake is therefore host-initiated *by definition*
in our architecture.

A theoretical guest→host push (`window.parent.postMessage` / `e.source.postMessage`) is **unverified**
— under Electron's MPArch inner-WebContents attachment (`guest.attachToIframe(embedder,
embedderFrameToken)`, `lib/browser/guest-view-manager.ts:209`) the guest's main frame is plausibly
the root of its own frame tree, making `window.parent === window`. I did not test this and will not
assert it either way. It is moot regardless: even if it worked, the guest still needs the host to
inject the code that would call it.

### The achievable equivalent

**Host-initiated, but re-armed on every document commit, with a sequenced round-trip ack.** That
recovers the property that matters (a new document always gets a fresh, verified channel) without
touching the security posture.

### Prior art: media-extended v3 (our MIT reference), branch `v3`

This is the strongest single piece of prior art because our code is adapted from it — and it already
does the thing we do not.

`apps/app/src/lib/remote-player/provider.ts:268-284` — `onDomReady` is a **persistent** listener that
re-runs the full inject + handshake on *every* `dom-ready`:

```ts
  onDomReady = async (evt: Event) => {
    const webview = this._webview;
    new HTMLMediaEvents(this, this._ctx);
    ...
    // prepare to recieve port, handle plugin load
    await evalInWebview(
      // replace placeholder with actual port message id
      init.replaceAll(`"${PORT_MESSAGE_ID_PLACEHOLDER}"`, JSON.stringify(this.#portMessageId)),
      webview
    );
    await this.loadPlugin(this.currentWebHost);
  };
```

`:315-323` — `untilPluginReady()` swaps in a one-shot listener for the first `dom-ready` after a src
change, then **restores the persistent one**:

```ts
  untilPluginReady() {
    const webview = this._webview;
    this.togglePlayReady(false);
    webview.removeEventListener("dom-ready", this.onDomReady);
    this.handlePlayReady();
    return new Promise<void>((resolve, reject) => {
      const onDomReady = (evt: Event) => {
        this.onDomReady(evt).then(resolve).catch(reject);
        webview.removeEventListener("dom-ready", onDomReady);
        webview.addEventListener("dom-ready", this.onDomReady);
      };
      webview.addEventListener("dom-ready", onDomReady);
    });
  }
```

`:167-189` — the handshake itself is **timeout-guarded and rejecting**, not fire-and-forget:

```ts
  loadPlugin(host: MediaHost) {
    return new Promise<void>((resolve, reject) => {
      const webview = this._webview as WebviewElement;
      const unsub = this.media.onReady(
        async () => {
          window.clearTimeout(timeoutId);
          await this.media.methods.loadPlugin(replaceEnv(plugins[host]));
          resolve();
        },
        { once: true }
      );
      const timeoutId = setTimeout(() => {
        unsub();
        reject(new TimeoutError(GET_PORT_TIMEOUT));
      }, GET_PORT_TIMEOUT);

      const { port1: portLocal, port2: portRemote } = new MessageChannel();
      this._port.load(portLocal);
      webview.contentWindow.postMessage(this.#portMessageId, "*", [portRemote]);
    });
  }
```

`GET_PORT_TIMEOUT = 5e3` (`apps/app/src/lib/remote-player/const.ts:1`).

`apps/app/src/lib/message/index.ts:45-56` — adopting a new port **closes the previous one first**,
and the ready signal is a genuine round trip (each end posts `PORT_READY_EVENT` on load; receiving
it is what emits `"ready"`):

```ts
  load(port: MessagePort) {
    if (this.port) {
      this.port.close();
    }
    this.port = port;
    const onMessage = ({ data }: MessageEvent) => {
      this.onMessage(data);
    };
    port.addEventListener("message", onMessage);
    port.start();
    port.postMessage(PORT_READY_EVENT);
  }
```

Its `#portMessageId = nanoid()` (`provider.ts:297`) is per-provider rather than per-attempt, so
media-extended still cannot distinguish a late ack from a dead document — see Q5.

Guest side, `apps/app/src/lib/remote-player/lib/init-port.ts:5-25`, is the same nonce-gated
`window.message` receiver we use, also with a rejecting timeout:

```ts
export default async function initPort() {
  const port = await new Promise<MessagePort>((resolve, reject) => {
    function onMessage({ data, ports }: MessageEvent<any>) {
      if (data !== PORT_MESSAGE_ID_PLACEHOLDER) return;
      resolve(ports[0]);
      window.removeEventListener("message", onMessage);
      window.clearTimeout(timeout);
    }
    window.addEventListener("message", onMessage);
    const timeout = setTimeout(() => {
      reject("failed to get port: timeout " + GET_PORT_TIMEOUT);
      window.removeEventListener("message", onMessage);
    }, GET_PORT_TIMEOUT);
  });
  ...
}
```

**Summary of the delta between media-extended and us:**

| | media-extended v3 | linsae (HEAD) |
|---|---|---|
| Handshake re-runs on every `dom-ready` | **yes** (`provider.ts:268`) | **no** — `if (rpc) return` (`playerSingleton.ts:176`) |
| Handshake failure is observable | **yes** — promise rejects, user notice (`:230-262`) | **no** — race result discarded (`:197`) |
| Old port closed before adopting a new one | **yes** (`message/index.ts:46-48`) | only via `load()` (`:302-303`) |
| Ready = port round-trip | **yes** (`PORT_READY_EVENT` both ways) | **no** — ready means "video element found" (`youtube-guest.ts:155`) |
| Nonce | per provider (`nanoid()`) | **fixed module constant** (`playerSingleton.ts:56`) |

---

## Q4 — Known upstream issues

I ran `gh search issues --repo electron/electron` for: `webview contentWindow postMessage`,
`webview MessagePort`, `dom-ready fires`, `dom-ready not fired webview`,
`webview executeJavaScript navigation race`, `postMessage transfer port webContents`,
`webview contentWindow null`, `guest page MessagePort renderer`. Total distinct relevant hits: **two**.

| Issue | State | Date | Relevance |
|---|---|---|---|
| [electron#997 — "Webview: no access to contentWindow"](https://github.com/electron/electron/issues/997) | **closed** 2015-01-12 | 2015 | Historical. `contentWindow` was once absent/removed; a 2015-09-06 comment asks how to `postMessage` "now that the `contentWindow` reference has been removed", maintainer replies *"I'd just shim it back in"*, and the reporter published [`electronic-post-message`](https://github.com/KidkArolis/electronic-post-message) as a workaround. It is **back** in 42.5.0 (Q2) via the iframe rewrite. Evidence that the surface is stable-in-practice but has no compatibility promise. |
| [electron#30367 — "webview cannot receive message via postMessage if create webview element while parent element is `display: none`"](https://github.com/electron/electron/issues/30367) | **closed** 2021-08-15, resolution: *"This is by design"* | Electron 9.2.1 | Directly relevant and **already handled**: `playerSingleton.ts:222-226 / :291-296` deliberately parks the wrapper off-screen instead of `display:none`, citing electron#7700. This issue independently confirms that decision protects the port path specifically, not just guest survival. |

**No upstream issue exists for:** `dom-ready` firing more than once, `dom-ready` not firing, a
MessagePort transfer into a guest silently failing, ports orphaned across guest navigation, or
`contentWindow` being null/stale after navigation.

**Interpretation — say this plainly:** the absence is not evidence the behaviours are absent. It is
evidence that **#213 is our bug, not Electron's**. Multiple `dom-ready`s are the documented,
intended, C++-verified behaviour (Q1); a port pushed into a doomed document being lost is correct
web semantics. There is no upstream fix to wait for and nothing to work around.

One structural risk worth recording: `spec/webview-spec.ts` @ `v42.5.0` has **no `contentWindow`
coverage**, so an upstream regression in this exact path would ship silently. Our
`SMOKE_PLAYBACK=1 pnpm smoke:thread` is, in practice, the regression test for it.

---

## Q5 — A correct re-armable handshake

### First: precisely why the current code fails

`playerSingleton.ts:174-205`, annotated:

```ts
async function onDomReady(): Promise<void> {
  const wv = webview
  if (rpc || !wv) return                                  // :176  ← one-shot latch, permanent
  const { port1, port2 } = new MessageChannel()           // :178
  rpc = createRpc(port1)                                  // :179  ← latched BEFORE any proof
  rpc.on('state', ...)                                    // :181
  rpc.on('time', ...)                                     // :184
  await safeExec(guestRuntime(NONCE))                     // :190  ← awaits an IPC round trip
  try {
    wv.contentWindow.postMessage(NONCE, '*', [port2])     // :192  ← may land in a dead document
  } catch (e) { console.warn('[player] port transfer failed', e) }
  await Promise.race([rpc.whenReady(), timeout(10000)])   // :197  ← result DISCARDED
  if (cover) cover.style.display = 'none'                 // :203  ← reveals regardless
  refreshSpinner()
}
```

Four independent defects, only the second of which #213 names:

1. **The latch is permanent and document-blind.** `rpc` non-null means "we once built a channel",
   not "we have a live channel to the *current* document". Since every cross-document navigation
   destroys the guest's JS world (Q1), a non-null `rpc` after a swap is *guaranteed* stale, not
   merely possibly stale.
2. **`rpc` is assigned before the transfer.** #213's point. Widens the blast radius of (1) to
   include half-built channels.
3. **The ack is not an ack.**
   - `rpc.whenReady()` (`rpc.ts:107-109`) resolves on a `{t:'ready'}` wire message (`rpc.ts:69-71`).
   - The guest sends that **only** from `attachVideo()`, `inject/youtube-guest.ts:152-155`:
     ```js
     // Initial state event
     emitState();
     // Signal host: chrome hidden, video found
     if (rpc) { rpc.ready(); }
     ```
     and `attachVideo` is reached only via `findVideo()`, `:162-166`:
     ```js
     function findVideo() {
       var v = document.querySelector('ytd-app #movie_player video');
       if (v) { attachVideo(v); return true; }
       return false;
     }
     ```
     So `whenReady()` means **"a `<video>` was found"**. On a consent wall it never resolves even
     though the port may be perfectly connected. It conflates transport liveness with page content.
   - `Promise.race([...])`'s value is thrown away at `:197`. Timeout and success are literally
     indistinguishable at the call site. **`whenReady()` as written cannot be the acknowledgement
     signal** — this answers the question in the brief directly: it is both too permissive (the
     result is ignored) and too strict (it requires a video).
4. **Failure is silent and slow.** On failure the user waits the full 10 s behind the black cover
   (`:197` → `:203`), then sees a working video with a dead transport and zero diagnostics.

Also note: `#213` cites the guard as `playerSingleton.ts:175` in its prose and
`scripts/thread-smoke.mjs:843` does the same; at HEAD it is `:176` (`:175` is `const wv = webview`).
Off by one — cosmetic, but this repo already has #215 open about drifted citations.

### Second: two hazards a naive fix will hit

**Hazard A — the guest runtime is not idempotent.** Re-injecting `guestRuntime(NONCE)` into the
*same* document installs a second copy of everything: media-event listeners on the `<video>`
(`:131-140`), a capture-phase `keydown` stopper (`:208`), two `MutationObserver`s (`:174-183`,
`:222-223`), and two 200 ms `setInterval` polls (`:241-244`, `:263-266`). Any retry-by-re-injecting
design must either inject at most once per document, or gate on a window sentinel. Note
`observerActive` (`:171-172`) guards only the *media* observer within one runtime instance — it does
nothing across two injected copies, because each copy has its own closure.

**Hazard B — the port receiver is one-shot per injection.** `inject/youtube-guest.ts:280-284`:

```js
  window.addEventListener('message', function onMsg(e) {
    if (e.data !== NONCE) return;
    window.removeEventListener('message', onMsg);
    initPort(e.ports[0]);
  });
```

It removes itself on the first match. A second port transfer into the same document is silently
dropped. So "retry the transfer without re-injecting" also fails today — the guest must expose a
re-arm hook.

Related, minor: the listener does not validate `e.source` or `e.ports.length`. Electron's own recipe
checks `event.source === window` — **do not copy that check verbatim here.** In the recipe the
message originates from the preload in the *same* window; in our case it originates from the *host*
window via `contentWindow.postMessage`, so `e.source` will not be `window`. What `e.source` actually
is for an embedder→guest message is **unverified** (see Open questions). A safe hardening that needs
no measurement is `if (!e.ports || e.ports.length !== 1) return`.

### Third: the recommended shape

Grounded only in APIs verified above: `dom-ready` (arm), `did-start-navigation` +
`isMainFrame && !isInPlace` (invalidate), `executeJavaScript(code)`, `contentWindow.postMessage(msg,
'*', [port])`, `MessageChannel`, `webview.getURL()`.

```
// ── module state ────────────────────────────────────────────────────────────
let rpc          = null      // ONLY non-null once acked for the CURRENT document
let pendingRpc   = null      // half-built channel awaiting ack
let handshakeSeq = 0         // monotonically increasing; identifies the current attempt
let attempts     = 0         // retries within the current document
const MAX_ATTEMPTS = 3
const ACK_TIMEOUT_MS = 3000  // media-extended uses 5000 for the same signal

// ── invalidate: a new document is coming, everything bound to the old one is dead ──
webview.addEventListener('did-start-navigation', (e) => {
  if (!e.isMainFrame || e.isInPlace) return      // in-page nav keeps the JS world alive
  teardown()                                     // see below
})

function teardown() {
  handshakeSeq++          // any ack still in flight is now stale by construction
  attempts = 0
  pendingRpc?.destroy()   // rpc.ts destroy() clears pending timers + closes the port
  pendingRpc = null
  rpc?.destroy()
  rpc = null
  resetCache()            // ← also the #211 fix; see Q6
}

// ── arm: fires once per committed main-frame document (Q1) ──────────────────
webview.addEventListener('dom-ready', () => {
  if (!isYoutubeChromeShown()) safeInsertCSS()   // unchanged; already correct
  attempts = 0
  void handshake()
})

async function handshake() {
  const wv = webview
  if (!wv || rpc) return                          // rpc non-null here == acked for THIS document
  if (attempts++ >= MAX_ATTEMPTS) { onHandshakeFailed(); return }

  const seq   = ++handshakeSeq
  const token = `${NONCE}:${seq}`                 // per-ATTEMPT token, not a module constant

  // 1. Inject at most once per document; later attempts only re-arm the receiver.
  //    guestRuntime must become idempotent: if window.__linsaeGuest exists it calls
  //    window.__linsaeGuest.arm(token) and returns instead of re-installing observers.
  const injected = await safeExec(guestRuntime(token))
  if (seq !== handshakeSeq) return                // document swapped mid-inject → abandon
  if (injected === undefined && !guestAlreadyInstalled) { return void retryLater() }

  // 2. Build the channel but DO NOT publish it.
  const { port1, port2 } = new MessageChannel()
  const candidate = createRpc(port1)
  pendingRpc = candidate

  // 3. Ack must be a ROUND TRIP carrying the token back.
  const acked = await Promise.race([
    waitForAck(candidate, token),                 // resolves true only on {t:'ack', token}
    delay(ACK_TIMEOUT_MS).then(() => false),      // NOTE: the result is USED, unlike :197
  ])

  // 4. A late ack from a dead document can never revive a stale port:
  //    both the sequence AND the echoed token must still be current.
  if (!acked || seq !== handshakeSeq) {
    candidate.destroy()
    if (pendingRpc === candidate) pendingRpc = null
    return void retryLater()                      // backoff, bounded by MAX_ATTEMPTS
  }

  // 5. Publish only now.
  pendingRpc = null
  rpc = candidate
  rpc.on('state', applyStateGuarded)              // guarded by videoId — see Q6
  rpc.on('time',  applyTimeGuarded)
  onHandshakeReady()                              // drop the cover HERE, not on a bare timeout
}
```

Guest side, the two changes that make the above possible:

```js
// idempotent install + re-armable receiver
(function (TOKEN) {
  if (window.__linsaeGuest) { window.__linsaeGuest.arm(TOKEN); return; }   // Hazard A
  var wanted = TOKEN;
  function onMsg(e) {
    if (e.data !== wanted) return;
    if (!e.ports || e.ports.length !== 1) return;
    initPort(e.ports[0], e.data);                 // do NOT removeEventListener — Hazard B
  }
  window.addEventListener('message', onMsg);      // installed ONCE, lives for the document
  window.__linsaeGuest = { arm: function (t) { wanted = t; } };
  ...
})("<token>");

function initPort(port, token) {
  if (rpc) { rpc.destroy(); }                     // media-extended message/index.ts:46-48
  rpc = buildRpc(port);
  rpc.ack(token);          // ← FIRST thing, before any DOM work. Proves the transport, nothing else.
  ...
  // rpc.ready() stays where it is, in attachVideo(), and now means only "video found".
}
```

**Why each piece is load-bearing**

- *Latch after ack, not before* — #213's requested fix. Necessary.
- *Invalidate on `did-start-navigation`* — the part #213 does not ask for and the part that fixes
  the wide window. Without it, a channel acked on document A survives as a healthy-looking corpse
  after A is replaced, and the only symptom is `rpc.invoke` rejecting after `invokeTimeoutMs`
  (default 1000 ms, `rpc.ts:23`) with a message no one reads.
- *Per-attempt token echoed in the ack* — answers "should we nonce/sequence each attempt": **yes.**
  Sequence alone is enough to reject a late ack, but the echoed token also proves the ack came from
  the document that received *this* port rather than a leftover runtime that re-armed. media-extended's
  per-provider `nanoid()` does not achieve this.
- *Ack ≠ ready* — split the two meanings that `whenReady()` currently fuses. `ack` = transport is
  live (send immediately, works on a consent page). `ready` = a `<video>` is hooked (keep at
  `youtube-guest.ts:155`). Then the cover-drop can key on `ready` with a short timeout while the RPC
  itself keys on `ack`, and the smoke can distinguish "port dead" from "consent wall" without the
  heuristic currently at `scripts/thread-smoke.mjs:847`.
- *Bounded retries* — `MAX_ATTEMPTS = 3` with backoff, then a terminal `onHandshakeFailed()` that
  logs once with `webview.getURL()`. Today the failure is invisible; a bounded loop that ends in a
  single diagnostic line would have made this a 5-minute diagnosis instead of an 8-run smoke study.

---

## Q6 — YouTube SPA video-change detection (for #211)

### Does this even matter for us? Yes, but the ordinary path is a document load.

`load(id)` (`playerSingleton.ts:299-307`) assigns `webviewEl.src`, which is a **cross-document**
navigation → `dom-ready` fires → the guest world is rebuilt. So the *common* video change is not an
SPA nav at all, and #211's "reset `cache` inside `load()`" is correct as far as it goes.

Two paths defeat that:

1. **A guest reset that does not go through `load()`** — consent redirect, sign-in interstitial,
   YouTube self-reload, crash recovery. `cache` keeps the pre-reset values; `cache.last` keeps the
   pre-reset state so `applyState`'s change gate (`:119`, `if (s !== cache.last)`) may swallow the
   first event of the new document. This is #211's "third, smaller" item, and it is the same root
   cause as #213 (no navigation invalidation). **`resetCache()` belongs in `teardown()`** from Q5,
   which `load()` then simply calls.
2. **A true SPA video change.** We suppress the usual triggers (autonav disabled at
   `youtube-guest.ts:231-244`, chrome hidden by `CLEAN_CSS`), but nothing *prevents* one — an
   end-screen click, a keyboard shortcut that survives, a YouTube UI change. In that case
   `dom-ready` does **not** fire (Q1), the port stays live, the MutationObserver at
   `youtube-guest.ts:168-184` re-hooks the new `<video>` — and the host silently keeps the old
   `videoId` and the old duration. The honest fix for that is guest-side.

### What is still real in 2026 — primary source

The authoritative sample is **SponsorBlock** (`ajayyy/SponsorBlock`, 13,507 stars, last push
2026-08-01) and its shared library `ajayyy/maze-utils`. It ships to millions of users daily, so its
event set is *empirically* current, not documentation-current.

`ajayyy/maze-utils`, `src/injected/document.ts:260-275` — the page-context script:

```ts
document.addEventListener("yt-player-updated", setupPlayerClient);
document.addEventListener("yt-navigate-start", navigationStartSend);
document.addEventListener("yt-navigate-finish", navigateFinishSend);

if (document.location.host === "tv.youtube.com") {
    document.addEventListener("yt-navigate", navigateFinishSend);
    document.addEventListener("ytu.app.lib.player.interaction-event", setupPlayerClient);
    ...
}

if (onMobile()) {
    window.addEventListener("state-navigateend", navigateFinishSend);
}
```

Note the target: **`document`**, not `window`. Several tutorials say `window` — SponsorBlock uses
`document` for desktop `yt-navigate-*` and `window` only for the mobile `state-navigateend`. Getting
this wrong is a silent no-op.

`ajayyy/maze-utils`, `src/video.ts:122-133` — the Navigation API, feature-detected:

```ts
// Register listener for URL change via Navigation API
const navigationApiAvailable = "navigation" in window;
if (navigationApiAvailable) {
    const navigationListener = (e) =>
        void videoIDChange(getYouTubeVideoID((e as unknown as Record<string, Record<string, string>>).destination.url));
    (window as unknown as { navigation: EventTarget }).navigation.addEventListener("navigate", navigationListener);

    addCleanupListener(() => {
        (window as unknown as { navigation: EventTarget }).navigation.removeEventListener("navigate", navigationListener);
    });
}
```

The Navigation API is available in our guest — Electron 42.5.0 is Chromium 148, and
`Navigation.navigate` shipped in Chromium 102
([MDN](https://developer.mozilla.org/en-US/docs/Web/API/Navigation/navigate_event)).

`ajayyy/maze-utils`, `src/injected/document.ts:155-175` — the actual **id read and dedupe**, which is
the most useful part for us:

```ts
function sendVideoData(): void {
    if (!playerClient) return;
    const videoData = playerClient.getVideoData();
    const isInline = playerClient.isInline();

    // Inline videos should always send event even if the same video
    // because that means the hover player was closed and reopened
    // Otherwise avoid sending extra messages
    if (videoData && (videoData.video_id !== lastVideo || lastLive !== videoData.isLive || lastInline !== isInline || isInline)) {
        lastVideo = videoData.video_id;
        ...
        sendMessage({
            type: "data",
            videoID: videoData.video_id,
            ...
        } as VideoData);
    }
}
```

and `:101-102`, the media-element triggers:

```ts
(playerClient.querySelector("video") as HTMLVideoElement)?.addEventListener("durationchange", sendVideoData);
(playerClient.querySelector("video") as HTMLVideoElement)?.addEventListener("loadstart", sendVideoData);
```

plus a `MutationObserver` fallback on the video container (`src/video.ts:483-488`).

`playerClient` is `#movie_player` — **the same object we already call `seekTo`, `unMute`,
`getVolume`, `setVolume` on** (`youtube-guest.ts:198-199`, `:254-259`). `getVideoData().video_id` is
therefore not new coupling; it is the same surface, and #211's fix can use it without widening our
YouTube-DOM exposure.

### `spfdone` — dead

`spfdone` belongs to [SPF (`youtube/spfjs`)](http://youtube.github.io/spfjs/documentation/events/),
the pre-Polymer YouTube navigation framework, retired years ago. Neither SponsorBlock nor
media-extended references it. **Do not use it.**

### What media-extended does (for contrast)

Nothing event-based. `apps/app/src/web/userscript/youtube.ts:160-173` uses only a `MutationObserver`
that re-hooks when the media element is detached:

```ts
  watchIfDetached() {
    const container = this.moviePlayer;
    const observer = new MutationObserver(async () => {
      if (this.media.isConnected) return;
      const lastest = await this.findMedia();
      if (!lastest) return;
      this.rehookMediaEl(lastest);
    });
    observer.observe(container, { childList: true, subtree: true });
    this.register(() => observer.disconnect());
  }
```

That is essentially our `setupObserver()` (`youtube-guest.ts:168-184`). It re-hooks the element but
never tells the host *which video* it re-hooked — the same gap we have.

### Recommendation for #211

Three layers, cheapest first. Layers 1–2 are the honest minimum; layer 3 is the one that makes the
class of bug impossible rather than fixed-in-one-place.

1. **Reset the cache on every guest reset, not just in `load()`.** Put
   `cache = { currentTime: 0, duration: null, last: 'unstarted' }` in the Q5 `teardown()`, and have
   `load()` call `teardown()`. Fixes #211's items 1–3 including the `cache.last` gate. This is
   #211's minimal fix, generalised to the paths that bypass `load()`.

2. **Delete the `durationDone` latch** in `usePlayer.ts:38-45` and `usePlayerState.ts:40-47` rather
   than resetting it. `setDuration(d)` with an unchanged `d` is a React bail-out (`Object.is`), so
   the latch saves nothing and costs a permanent-staleness failure mode. #211 already flags the
   latch as "still fragile" after the cache fix; deleting it removes the fragility instead of
   documenting it. Keep the `d != null` check.

3. **Stamp every guest event with the guest's own video id, and drop mismatches host-side.** In the
   guest, resolve the id as
   `document.getElementById('movie_player')?.getVideoData?.().video_id` with a
   `new URLSearchParams(location.search).get('v')` fallback, attach it to the `state` and `time`
   payloads, and additionally emit a `navigate` event from
   `document.addEventListener('yt-navigate-finish', ...)` (SponsorBlock-verified spelling and
   target). Host-side, `applyState`/the `time` handler ignore any payload whose id ≠ the expected
   `videoId`. This closes the SPA path and makes a stale write to `video_sources`
   (`ThreadView.tsx:241-247`) structurally impossible rather than merely unlikely.

If layer 3 is out of budget for the milestone, file it as its own issue — but say in the issue that
layers 1–2 leave the SPA path open, so the issue is not mistaken for a duplicate of #211.

---

## Q7 — Testability

### What happy-dom genuinely covers — more than the current tests use

**The entire host half of the handshake is testable in happy-dom today.** `MessageChannel` and
`MessagePort` are real there — proven by `src/renderer/src/yt/rpc.test.ts:7-13`, which drives a full
invoke round trip across `new MessageChannel()` under `// @vitest-environment happy-dom`
(happy-dom 20.9.0, `package.json:68`).

**Yet the handshake has zero coverage right now.** `playerSingleton.test.ts:4-23`'s `stubWebview`
provides `executeJavaScript`, `insertCSS`, `setUserAgent` — **no `contentWindow`** — and **no test
anywhere dispatches `dom-ready`** (`grep -rn "dom-ready" src/renderer/src/yt/*.test.* tests/` returns
one comment in `PlayerPane.test.tsx:364` and nothing else). So `onDomReady` never executes in the
suite; if it did, `wv.contentWindow.postMessage` would throw `TypeError` straight into the
`catch` at `:193`. Every line of `playerSingleton.ts:174-205` is unexecuted by Vitest.

Closing that is a small, high-value change and does **not** need real Electron:

```ts
// extend stubWebview
const guestPorts: MessagePort[] = []
Object.assign(el, {
  executeJavaScript: vi.fn(async () => undefined),
  insertCSS: vi.fn(async () => 'key'),
  contentWindow: {
    postMessage: (msg: unknown, _origin: string, transfer: MessagePort[]) => {
      guestPorts.push(transfer[0])            // stand in for the guest
    },
  },
})
// then: el.dispatchEvent(new Event('dom-ready'))
```

With that, these are all unit-testable, and each corresponds to a specific defect above:

- `dom-ready` twice → **two** distinct ports transferred, and the second channel is the live one
  (the #213 regression test).
- `did-start-navigation` with `{ isMainFrame: true, isInPlace: false }` → `rpc` becomes null and
  `cache` resets (the #211 layer-1 regression test).
- `did-navigate-in-page` / `isInPlace: true` → `rpc` is **not** torn down (guards against
  over-invalidating and reloading the world on every YouTube SPA nav).
- A guest that never acks → `rpc` stays null, bounded retries stop at `MAX_ATTEMPTS`, cover still
  drops (no 10 s black screen).
- A **late** ack carrying a superseded token → ignored, live channel unaffected (the
  sequencing test).
- Guest-side idempotence: `guestRuntime(token)` is a pure string builder, so a test can assert the
  sentinel branch exists — though its *runtime* behaviour is only checkable in a real page.

Note the events must be dispatched as plain `new Event('dom-ready')` with properties assigned, since
happy-dom has no webview element. That is exactly how Electron itself constructs them
(`web-view-impl.ts:117-120`: `const event = new Event(eventName); Object.assign(event, props);`), so
the fidelity is high.

### What genuinely requires real Electron

- Whether `contentWindow.postMessage` actually reaches an OOPIF guest (Q2) — this is the one thing a
  stub can never prove, and it is the assumption ADR 0016's Task-1 spike was created to test.
- Real YouTube document-swap timing, consent redirects, the true `dom-ready` count on a live watch
  page.
- Anything geometric — already argued at length in `scripts/thread-smoke.mjs:14-31`.

`pnpm smoke:thread` (Playwright `_electron`, `scripts/thread-smoke.mjs:53`) is the right vehicle;
`playwright.config.ts` + `tests/visual/*.spec.ts` (the v0.8.1 `@playwright/test` harness) is for
screenshots, not this.

### Making the 1-in-7 reproducible on demand

Ranked by determinism.

**1. Main-process request interception — fully deterministic, closest to the real cause.** In the
smoke's Electron entry, intercept the first `https://www.youtube.com/watch*` request on the
`persist:yt-player` session and serve a tiny interstitial that immediately replaces itself:

```js
// only under an env flag, e.g. SMOKE_FORCE_SWAP=1
session.fromPartition('persist:yt-player').protocol /* or webRequest.onBeforeRequest */
// → first /watch hit returns:  <script>location.replace(REAL_WATCH_URL)</script>
```

This reproduces the consent-wall shape exactly: `dom-ready` fires for the interstitial, the runtime
is injected there, `rpc` latches, the redirect commits, and the second `dom-ready` is refused. On
HEAD this must fail 100 % of the time; after the fix it must pass 100 % of the time. **This is the
gate to write** — it converts the acceptance criterion in #213 ("N ≥ 10 consecutive runs") from a
statistical argument into a deterministic one.

**2. Host-driven re-navigation — deterministic, narrower.** From the smoke, on the first `dom-ready`,
immediately reassign `wv.src` to the same watch URL. Forces a second document commit while the first
handshake is in flight. Simpler than (1) but exercises the narrow window #213 describes rather than
the wide one that actually dominates.

**3. Latency injection — probabilistic, useful for widening (2).** Wrap the host's
`executeJavaScript` in a delay under a flag so the gap at `:190-192` is milliseconds wide instead of
microseconds. Do not rely on it as the gate; use it to raise the hit rate while iterating.

Whichever is chosen, keep the smoke's existing distinction between "consent wall" (skip) and "RPC
dead" (fail) at `scripts/thread-smoke.mjs:836-870` — and once the guest sends a transport-level
`ack` separate from `ready` (Q5), that heuristic can become a direct readout instead of an inference
from `diag.consent || !diag.hasVideo`.

---

## Recommended fix shape (summary)

Two issues, one root cause: **nothing in the player invalidates state when the guest document is
replaced.** #213 is the RPC channel not being invalidated; #211 is the value cache not being
invalidated. A single `teardown()` on `did-start-navigation` addresses both, which argues for fixing
them in one batch rather than as two independent patches.

**For #213 (`playerSingleton.ts`)**
1. Add a `did-start-navigation` listener; on `isMainFrame && !isInPlace`, run `teardown()`
   (bump sequence, destroy `rpc` and any pending candidate, reset `cache`).
2. Make `dom-ready` re-arm unconditionally — delete the `if (rpc)` term from `:176`.
3. Build the channel into a local `candidate`; publish to `rpc` **only** after a token-echoing ack.
4. Per-attempt token (`${NONCE}:${seq}`), not the module constant at `:56`.
5. Use the `Promise.race` result at `:197` instead of discarding it; drop the cover on `ready` (or on
   a bounded failure), never on an ignored timeout.
6. Bounded retries (≈3) with backoff and one terminal diagnostic including `webview.getURL()`.

**For the guest (`inject/youtube-guest.ts`)**
7. Sentinel-guard the whole IIFE (`window.__linsaeGuest`) so a second injection re-arms instead of
   duplicating listeners, intervals and observers.
8. Keep the `message` listener installed for the document lifetime; re-arm the expected token rather
   than `removeEventListener`. Validate `e.ports.length === 1`.
9. Send `ack(token)` as the first act of `initPort`, before any DOM work. Leave `ready()` in
   `attachVideo()` — the two now mean different things.

**For #211 (`playerSingleton.ts`, `usePlayer.ts`, `usePlayerState.ts`)**
10. `resetCache()` inside `teardown()`; `load()` calls `teardown()`.
11. Delete the `durationDone` latch in both hooks.
12. (Separable) Stamp guest `state`/`time` payloads with the guest's own `video_id` and drop
    mismatches host-side; emit a `navigate` event from `document.addEventListener('yt-navigate-finish', …)`.

**Sizing against the Inline-fix gate.** This is not a nit — it is a p1 bug fix, so the capability
gates do not apply. But it does touch 4–5 implementation files with a control-flow delta well past
+3, so it is milestone work with tests, not an inline fix. Items 1–11 are one coherent unit; item 12
is separable and should be its own issue if it does not fit.

**ADRs.** No ADR reversal is required — the fix stays inside ADR 0016 D7 (no preload) and D8
(security guard untouched). An ADR *is* warranted for the handshake protocol itself: "guest RPC
handshake is re-armed per document with a sequenced ack", recording why `dom-ready` alone is
insufficient and why the preload path was rejected again. Worth writing because it is exactly the
kind of decision a future agent would otherwise reverse by "simplifying" the guard back to a latch.

---

## Open questions / what I could not verify

- **Whether `contentWindow.postMessage` into an OOPIF guest can fail *silently* under conditions we
  have not hit.** I verified the property exists and is defined by Electron (Q2); I did not run
  Electron. The ADR 0016 Task-1 spike verified it on Electron 39. It has not been re-verified on 42.
  Marked **unverified** for 42.
- **What `e.source` is inside the guest for an embedder→guest `contentWindow.postMessage`.**
  Unverified. Consequently: do **not** add Electron's `event.source === window` check to
  `youtube-guest.ts:280` — the recipe's premise (same-window preload origin) does not hold for us,
  and copying it could break the receiver outright.
- **Whether a guest can post *up* to the host (`window.parent` / `e.source.postMessage`).**
  Unverified under Electron 42's `attachToIframe` inner-WebContents model. Moot for our design (Q3),
  but it is the thing to measure first if a preload-free guest-initiated handshake is ever revisited.
- **Whether the host port receives a `close` event when the guest document is destroyed.** Electron
  documents `close` — *"the `close` event, which is emitted when the other end of the channel is
  closed. Ports can also be implicitly closed by being garbage-collected"*
  (`docs/tutorial/message-ports.md` § "Extension: `close` event"). Whether document teardown fires it
  **promptly**, or only at GC, is unverified. If it is prompt it would be a second, cheap
  invalidation signal — but **do not build on it without measuring**; `did-start-navigation` is
  deterministic and needs no measurement.
- **The true distribution behind "1 in 7."** I did not reproduce it. My claim is that the dominant
  mechanism is a wider window than #213 describes (whole first document vs. the inject→post gap),
  supported by `scripts/thread-smoke.mjs:841-846` reaching the same conclusion independently. The
  deterministic repro in Q7 would settle it — and if the interception repro fails to reproduce, the
  narrow race is the real one and my emphasis is wrong.
- **Whether YouTube ever fires more than one `dom-ready` on a *steady* watch page** (no redirect, no
  `load()`). Per the C++ it should not. Unverified empirically. If it does, item 2 above would cause
  a redundant re-handshake — harmless once the guest is idempotent (item 7), which is another reason
  item 7 is not optional.
- **`getVideoData()` stability.** SponsorBlock depends on `playerClient.getVideoData().video_id`
  today (2026-08-01 push), which is strong evidence it is current. It is still undocumented YouTube
  internals and lives under the same ADR 0016 "YouTube DOM churn" caveat as our existing
  `#movie_player` calls. The `?v=` URL fallback should always be present.

---

## Sources

**Electron, pinned at `v42.5.0`**
- `docs/api/webview-tag.md` — <https://github.com/electron/electron/blob/v42.5.0/docs/api/webview-tag.md>
- `docs/api/web-contents.md` — <https://github.com/electron/electron/blob/v42.5.0/docs/api/web-contents.md>
- `docs/api/web-frame-main.md` — <https://github.com/electron/electron/blob/v42.5.0/docs/api/web-frame-main.md>
- `docs/tutorial/message-ports.md` — <https://github.com/electron/electron/blob/v42.5.0/docs/tutorial/message-ports.md>
- `lib/renderer/web-view/web-view-impl.ts` — <https://github.com/electron/electron/blob/v42.5.0/lib/renderer/web-view/web-view-impl.ts>
- `lib/renderer/web-view/web-view-element.ts` — <https://github.com/electron/electron/blob/v42.5.0/lib/renderer/web-view/web-view-element.ts>
- `lib/browser/web-view-events.ts` — <https://github.com/electron/electron/blob/v42.5.0/lib/browser/web-view-events.ts>
- `lib/browser/guest-view-manager.ts` — <https://github.com/electron/electron/blob/v42.5.0/lib/browser/guest-view-manager.ts>
- `shell/browser/api/electron_api_web_contents.cc` — <https://github.com/electron/electron/blob/v42.5.0/shell/browser/api/electron_api_web_contents.cc>
- `spec/webview-spec.ts` — <https://github.com/electron/electron/blob/v42.5.0/spec/webview-spec.ts>
- `node_modules/electron/electron.d.ts` (local, 42.5.0) — `interface WebviewTag` `:19412-20053`, `interface DidStartNavigationEvent` `:21202-21208`

**Electron issues**
- electron#997 — <https://github.com/electron/electron/issues/997> (closed 2015-01-12)
- electron#30367 — <https://github.com/electron/electron/issues/30367> (closed 2021-08-15, "by design")
- `electronic-post-message` shim — <https://github.com/KidkArolis/electronic-post-message>

**Prior art**
- aidenlx/media-extended, branch `v3` (MIT; our adaptation source per ADR 0016 D10) —
  `apps/app/src/lib/remote-player/provider.ts`, `.../lib/init-port.ts`, `.../const.ts`,
  `apps/app/src/lib/message/index.ts`, `apps/app/src/components/webview/index.tsx`,
  `apps/app/src/web/userscript/youtube.ts` — <https://github.com/aidenlx/media-extended/tree/v3>
- ajayyy/SponsorBlock (13.5k★, pushed 2026-08-01) — <https://github.com/ajayyy/SponsorBlock>
- ajayyy/maze-utils — `src/injected/document.ts`, `src/video.ts` — <https://github.com/ajayyy/maze-utils>
- SPF (`spfdone`, retired) — <http://youtube.github.io/spfjs/documentation/events/>
- MDN, Navigation API `navigate` event — <https://developer.mozilla.org/en-US/docs/Web/API/Navigation/navigate_event>

**This repo (all citations at HEAD, `main`)**
- `src/renderer/src/yt/playerSingleton.ts`, `rpc.ts`, `usePlayer.ts`, `usePlayerState.ts`,
  `PlayerPane.tsx`, `playerSingleton.test.ts`, `rpc.test.ts`
- `src/renderer/src/yt/inject/youtube-guest.ts`
- `src/main/index.ts:262-300` (webview security guard)
- `scripts/thread-smoke.mjs`
- `adrs/0016-webview-youtube-player.md`
- utof/linsae#211, #212, #213, #215
