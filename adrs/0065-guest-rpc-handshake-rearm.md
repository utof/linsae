# 0065 — The guest RPC handshake is re-armed per document, with a sequenced ack

Status: accepted (v0.8.3)
Date: 2026-08-03

> Written for the reader who is about to delete something here because it looks redundant. Every
> "why not simpler" answer below should be reachable without opening the git history — that is the
> whole point of the file. The guard this replaces survived two milestones precisely because the
> simple version looks right.

## Context

The docked YouTube player drives the in-page `<video>` over a `MessagePort` RPC transferred into the
guest with `contentWindow.postMessage` (ADR 0016 D7/D9). Until v0.8.3 the host opened that channel in
a single `dom-ready` handler whose first line was `if (rpc || !wv) return`, and which assigned
`rpc = createRpc(port1)` **before** injecting the guest runtime and **before** transferring the port.

Two failures follow from that one shape, and only the first was filed (#213):

- **Narrow.** The guest swaps documents between the injection and the transfer. The port is orphaned,
  `rpc` is non-null anyway, and every later `dom-ready` is refused.
- **Wide, and dominant.** `dom-ready` fires once per **committed main-frame document**. If the first
  committed document is a consent wall or a redirect hop, the runtime is injected *there* and `rpc`
  latches to *it*. The real watch page's `dom-ready` is then refused **in the steady state** — not in
  a race, and not recoverably. This is the mechanism `scripts/thread-smoke.mjs`'s `forceDocumentSwap`
  reproduces deterministically.

**Nothing said so.** `play()` bypasses the RPC by design (it needs `executeJavaScript`'s user-gesture
flag), and `safeInsertCSS()` sits outside the guard and re-fires on every `dom-ready` — so in exactly
the runs where the channel is dead, the chrome still hides and the video still starts on a click. A
dead transport is visually indistinguishable from a live one. ADR 0064 § Consequences records the
observation from the other side: its `SMOKE_PLAYBACK=1` bullet notes the smoke going red with a
healthy `<video>`, no consent lightbox, and not one `state` event reaching the host. **That sentence
described an observed bug, not a decision — 0064 is not superseded by this file.** This milestone is
what closed it.

The value cache had the same omission with a different blast radius: `load(id)` destroyed `rpc` but
never touched `cache`, so `getDuration()` kept answering with the *previous* video's duration long
enough for `ThreadView`'s write-back to put it on the incoming video's `video_sources` row — on disk,
surviving restart (#211).

Both are one thing: **nothing invalidated guest-derived state when the guest document was replaced.**

## Decision

**D1 — `dom-ready` is the authoritative invalidation point; `did-start-navigation` is an early
warning that may never commit.**

`dom-ready` means a new document has committed, which makes any existing channel dead *by
definition*. So the `dom-ready` handler calls `teardown()` **first**, and `handshake()`'s entry check
carries no `rpc` term at all. `did-start-navigation` also tears down, because acting on the early
warning shortens the window in which a doomed channel can still answer invokes — but it is never
trusted to be followed by anything.

The direction matters. Making the *early* signal authoritative would leave a `dom-ready` that arrives
with no tracked navigation unhandled; making the *committed* signal authoritative handles both, and
costs one extra `resetCache()` per document, which is correct anyway.

**D2 — `rpc` is non-null iff a channel has been acknowledged by the document that is currently
committed (contract C1).**

A half-built channel lives in `pendingRpc`, never in `rpc`. It is module state rather than a local so
that `teardown()` can destroy it: a candidate whose ack never arrives would otherwise hold an open
port until its own deadline expired, outliving the document it was built for.

**D3 — the ack echoes the token of the attempt that sent it (contract C4).**

Each attempt sends `${NONCE}:${seq}` where `seq` comes from a monotonic `handshakeSeq` that
`teardown()` bumps. `whenAck(token)` resolves only on an `{ t: 'ack' }` carrying exactly that token.
A bare "an ack arrived" signal is not enough: the host re-injects on retry and on the C6 watchdog
path, so more than one attempt can be outstanding against one document, and a late ack from a
superseded attempt would otherwise publish a channel whose guest end `initPort` has already
destroyed. `handshake()` re-checks `seq` at **every** resume point, and a superseded attempt **stands
down silently rather than retrying** — retrying would re-arm the guest with a new token, and the
guest's `initPort` destroys its prior rpc, killing the peer of a channel the host had already
published. That is the exact state C1 exists to make impossible.

**D4 — `ack` and `ready` are different facts, and the cover keys on `ready`-or-timeout, never on
`ack` (contract C3).**

`ack` is the first act of `initPort`, ahead of any DOM work: it says *the transport is live*, and it
fires on a consent page that has no `<video>` at all. `ready` is sent from `attachVideo()` and says
*a `<video>` is hooked*. Neither may be inferred from the other.

Both directions of getting this wrong have been shipped:

- **Dropping the cover on the transport signal** was `47a05f7` ("reveal the video when chrome CSS
  paints, not after the RPC handshake"). It exposed YouTube's muted-autoplay startup churn as a
  "muted, plays 1 s, then stops" flash and was reverted in `1863ffa`. Tracked as #65 — still open,
  because the *want* is legitimate; only this particular signal is not.
- **Dropping the cover only on `ready`-or-*failure*** leaves the player permanently black on a
  consent wall, where the handshake **succeeds** and `ready` simply never fires. That regression was
  written into an earlier revision of this milestone's spec and caught in review.

So the cover is decoupled from the handshake entirely: `armCoverTimer()` is armed by `dom-ready`
outside `handshake()`, and `dropCover` runs on whichever of `whenReady()` or the timer comes first,
**regardless of handshake outcome**. This is also why the webview is left interactive — the escape
hatch is only an escape hatch if the user can click the wall it reveals.

**D5 — `did-start-navigation` is paired with a watchdog (contract C6).**

`did-start-navigation` and `dom-ready` are **not** a matched pair. Electron emits the former
unconditionally, while its sibling `DidFinishNavigation` early-returns on
`!navigation_handle->HasCommitted()` — uncommitted navigations are a first-class case in Electron's
own C++, not a corner (both verified in `shell/browser/api/electron_api_web_contents.cc` at the
`v42.5.0` tag; the Chromium-side sources for multiple concurrent navigations and for 204/205 +
`Content-Disposition` responses are collected in spec §5.3).

**This repo manufactures uncommitted navigations itself.** `src/main/index.ts`'s `will-navigate`
handler `preventDefault()`s every guest hop whose hostname misses `GUEST_HOST_ALLOW` — every ad
click-through and every off-allowlist description link. (Sign-in is *not* one of them: the allowlist
carries `google.com` so the consent/login flow can complete in place.) BFCache restores are the
upstream sibling.

Without the watchdog, `teardown()` nulls `rpc`, nothing commits, `handshake()` is never re-entered,
and the C6 diagnostic never fires either — **the player is silently dead in a case where the old
latching code kept working.** `onNavigationStalled` re-enters `handshake()` against whatever document
is current, which is the right action even for a cancelled navigation: a cancelled navigation leaves
the *previous* document in place, and that document is exactly what the channel should be talking to.
If there is genuinely no live document, the port transfer throws, retries, exhausts, and
`onHandshakeFailed()` emits exactly one `console.warn` carrying `webview.getURL()`.

**D6 — the guest is idempotent, and its work is split per-document vs. per-channel.**

A second injection into one document is a **supported call**, because the host re-injects on every
retry and on every watchdog re-arm. The runtime short-circuits on a `window.__linsaeGuest` sentinel
and only re-arms the expected token; the `message` receiver stays installed for the document's
lifetime instead of removing itself on first match.

The split is the load-bearing part:

- **`initPort()` is per-CHANNEL.** It destroys any prior rpc, builds the new one, acks, and registers
  invoke handlers.
- **`wireDocument()` is per-DOCUMENT.** It no-ops on `domWired` and owns everything that outlives a
  channel: the capture-phase `keydown` stopper, both `MutationObserver`s, the three 200 ms
  `setInterval`s, and the `<video>` hunt.
- Everything hoisted into `wireDocument()` reads the **closure** variable `rpc`, which `initPort`
  repoints — so a re-armed host receives those events without a second copy of the listener,
  observer or interval that produces them.

This is recorded as a decision because two plausible reversals sit right next to it, and both are
regressions:

- **Hoisting the `<video>` hunt out of `wireDocument()` into `initPort()`.** On a document with no
  `<video>` yet, the `if (!findVideo())` branch starts a 200 ms `setInterval`; a re-arm would start a
  second one. That is exactly the duplication C5 forbids.
- **Forcing a re-attach on re-arm** (dropping `attachVideo`'s `if (v === videoEl) return`, or nulling
  `videoEl` in `initPort`). That installs a **second** copy of all 11 media-event listeners on the
  same element, so every state transition is reported twice.

**D7 — the preload path stays rejected; ADR 0016 D7/D8 is untouched.**

Routing the port through a guest preload (or through main, via `webContents.postMessage` /
`frame.postMessage`) is closed **by construction**, not by preference: `src/main/index.ts`'s
`will-attach-webview` clamp does `delete prefs.preload` and `nodeIntegration = false`, so there is no
`ipcRenderer` in the guest to receive a port. Taking that path means reversing ADR 0016 D8's security
posture to work around a bug that had nothing to do with the transfer mechanism.

**ADR 0016 D7 is not contradicted by re-injection and needs no amendment** (checked as part of this
milestone). D7 decides *how* the runtime is injected — `executeJavaScript` into the page's main
world, no preload, no `unsafe-eval`, no CSP strip. It is silent on how many times, which is the
correct posture: D6 above changes the count, not the mechanism.

## Alternatives

- **Keep the latch and just fix the ordering** (assign `rpc` after the transfer rather than before).
  Rejected: it closes only #213's narrow half. The wide half — a consent wall or redirect owning the
  channel forever — is untouched, because the refusal comes from `rpc` being non-null at the *next*
  `dom-ready`, not from when it was assigned.
- **Replace `contentWindow.postMessage`.** Rejected. It is undocumented and absent from
  `electron.d.ts` (we hand-declare it), but Electron 42.5.0 *defines* `contentWindow` in
  `lib/renderer/web-view/web-view-impl.ts` and depends on it internally. #213 was never a wrong-API
  bug, and swapping the API would have looked like a fix while leaving the invalidation missing.
- **A global circuit breaker on `attempts`.** Rejected. `attempts` resets in `teardown()`, so
  `maxAttempts` is spent **per document**, which is the correct semantics for a redirect chain. A
  pathologically self-redirecting page yields repeated injections; that is accepted and stated so a
  future reader does not mistake the absence of a global bound for an oversight.
- **Reset the cache only in `load()`.** Rejected — that is HEAD's bug with a smaller radius. The
  consent redirect and YouTube's own self-reload replace the document without going through `load()`,
  which is why `resetCache()` belongs in `teardown()`.
- **Notify `stateCbs` from `resetCache()`.** Rejected, and there is an inline comment saying so:
  React consumers keep the previous `state` until a real guest event arrives. It is safe because the
  guest's `flags()` hard-codes `ready: true`, so `deriveState` can never return `'unstarted'` from a
  guest event and the reset value cannot collide with the incoming video's first real state.
  Notifying would flash every video change through a synthetic state no guest ever sent.
- **Expose `ack` to `PlayerPane` so the rate re-push can key on it** (#212). Deferred, not rejected.
  `ack` is the correct signal — the pane currently keys on a `state` event because that was the only
  public evidence the new port was live — but wiring it is a separate change and #212 stays open
  saying exactly that.

## Consequences

**The `rpc` term in `handshake()`'s entry check is dead, and re-adding it is invisible to the
suite.** Measured: restoring `if (rpc || !wv) return` alone leaves `playerSingleton.test.ts` green at
26/26, because `dom-ready`'s `teardown()` has already nulled `rpc` before `handshake()` runs. What T1
actually detects is deleting `teardown()` from the `dom-ready` handler — that alone turns T1 red, and
so does the pair. Recorded so nobody re-derives the dead half and concludes the guard is harmless: it
*is* harmless today, and it is the exact line that becomes #213 again the moment the teardown moves.

**The §7 ordering invariant is not hook order, it is that neither hook reads `getDuration()` during
the effect phase — and nothing in this repo tests it.**

`usePlayer` and `usePlayerState` both defer their first duration read to a rAF tick, and React
flushes both effects in one commit, so no frame can land between them. Measured: swapping the two
hook calls in T12's probe is **inert** — green both ways, three runs. It stops being inert the moment
either hook reads during the effect phase: adding a `player.getDuration().then(setDuration)` at the
top of `usePlayerState`'s effect makes the shipped order green and the swapped order red (measured
both ways).

Two things make this worth a permanent record:

1. **The invariant is unenforced.** T12's recorded falsifier is *dropping `resetCache()` from
   `teardown()`* — which is shared with T2 and T7 and turns two `playerSingleton.test.ts` tests red
   as well. So T12 cannot distinguish "the ordering property was lost" from "the cache reset was
   lost". **This ADR is the only artifact in the repo that records the property at all.**
2. **Production is not the shape the invariant assumes, and this is a live residual.** In production
   the two hooks are not siblings in one commit: `PlayerPane` owns the sole `usePlayer` and reads its
   `videoId` from the `player.videoId` app-setting via `useSetting` (react-query over IPC), while
   `ThreadView` owns `usePlayerState` and *writes* that setting from its own effect through
   `useSetSetting` — which has no optimistic update, so `PlayerPane` only learns the new id after a
   `settings.set` round-trip, an invalidation, and a `settings.get` refetch. `usePlayerState`'s rAF
   loop starts on the frame after `ThreadView` mounts, with `last = 0`, so its first
   `getDuration()` lands well before `usePlayer`'s `player.load(B)` reaches `teardown()`. On a
   thread switch away from a video whose duration is cached, that first read returns the **outgoing**
   video's duration, `ThreadView`'s `durationWrittenRef` latches it, and `api.videoSources.upsert`
   writes it to the incoming video's row. That is #211's exact symptom reached ahead of `load()`
   rather than through it. **Traced through source, not executed** — it is recorded here so it is
   investigated as a known gap rather than rediscovered as a new bug, and it is why #211 should be
   closed on the `load()`-path claim its acceptance actually names.

   (Note also that the tree position of the two hooks is a static fact, not a user choice: the player
   pane's `homeDock` is `'right'` in the `PANES` registry, `openPane` always uses it, `hydrate` drops
   content-kind panes, and the only dock drag is a width drag. `App` renders the left `DockHost`,
   then `<main>` holding `ThreadView`, then the right `DockHost` — so when the two effects *do* share
   a commit, `usePlayerState`'s runs first.)

**`needsInteraction` is not authoritative after ANY re-arm of an already-wired document.** The C6
watchdog is the loudest such path, not the only one — the ordinary ack-timeout retry reaches the same
state. `retryLater` re-enters `handshake()`, whose injection hits the guest's `__linsaeGuest`
short-circuit; the new port lands in `initPort`, and the `wireDocument()` it calls no-ops on
`domWired`. `checkConsent()` therefore never re-runs, `lastConsentActive` stays latched in the guest
closure, and `checkConsent` only emits on a *transition* — so the wall is never re-announced.
`createRpc`'s `on()` has no replay buffer (it is a plain listener `Set`), so the first attempt's
emission is unrecoverable on the second channel. Concretely: **on a walled document whose first
attempt's ack times out, the attempt that publishes reads `false`**, and the smoke reports a wall as
a transport break. `false` here means "no guest has told us otherwise", never "provably no wall". The
same gap denies a re-armed channel its initial `state` and its `ready` (`attachVideo` early-returns
on `v === videoEl`); one `initPort` re-sync closes all three, and is filed as such.

**Known residual — a guest renderer crash is not covered.** A crash replaces the document with **no
navigation at all**: no `did-start-navigation`, no `dom-ready`, so nothing tears down and `rpc` stays
non-null and dead. Neither the pre-v0.8.3 code nor this design handles it. `render-process-gone` is a
forwarded `<webview>` event at `v42.5.0` (`lib/browser/web-view-events.ts`) and is the signal if it
is ever wanted. Out of scope here; recorded so it is not rediscovered as a new bug.

**Known residual — Electron silently drops a `<webview>` `src` assignment made before the guest
attaches.** `SrcAttribute.parse()` returns early while `guestInstanceId == null`; only the *first*
assignment in that window does anything (it flips `beforeFirstNavigation` and calls `createGuest()`),
and `guestInstanceId` arrives an IPC round-trip later via `attachGuestInstance` (both verified at the
`v42.5.0` tag). This is filed here rather than as a smoke-only note because `load()` writes the same
attribute through the same code path: two `load()` calls straddling that window leave the singleton's
`videoId` naming a video the webview never navigated to. It is also what shaped this milestone's
real-Electron gate, whose homepage→watch forcing needs a **bounded re-assertion loop** rather than a
single write — a same-value write works, because `SrcAttribute`'s own `MutationObserver` exists to
catch exactly that, and the loop must be bounded because each accepted assignment cancels the
navigation the previous one started.

**A dead transport is now audible.** `onHandshakeFailed()` is the one thing standing between this
class of bug and another two milestones of silence. It is one `console.warn` per exhausted document,
carrying `getURL()`, and `scripts/thread-smoke.mjs`'s `SMOKE_FORCE_SWAP=1` gate is what keeps the
re-arm itself falsifiable in a real Electron.

**Two invalidation calls per committed document is intentional.** `did-start-navigation` and then
`dom-ready` both call `teardown()`, so a normal navigation resets the cache twice. Collapsing them to
one is the reversal D1 exists to prevent.

## Sources

- `src/renderer/src/yt/playerSingleton.ts` — `teardown`, `handshake`, `raceAck`, `retryLater`,
  `discard`, `onHandshakeFailed`, `onNavigationStalled`, `armCoverTimer`, `dropCover`, `resetCache`,
  `setNeedsInteraction`, `handshakeConfig`
- `src/renderer/src/yt/rpc.ts` — the `Wire` union's `{ t: 'ack'; token }` member, `whenAck`, and
  `on()`'s listener `Set` (no replay buffer)
- `src/renderer/src/yt/inject/youtube-guest.ts` — `initPort` (per-channel), `wireDocument`
  (per-document), `arm`, the `__linsaeGuest` sentinel, `attachVideo`'s `v === videoEl` guard
- `src/renderer/src/yt/usePlayer.ts`, `src/renderer/src/yt/usePlayerState.ts` — the rAF tick that
  defers the first `getDuration()`; `src/renderer/src/yt/PlayerPane.tsx` (`useSetting`),
  `src/renderer/src/thread/ThreadView.tsx` (`useSetSetting`, `durationWrittenRef`),
  `src/renderer/src/lib/use-setting.ts` (no optimistic update)
- `src/renderer/src/panes/Pane.tsx` (`PANES`, `homeDock`), `src/renderer/src/panes/dockStore.ts`
  (`openPane`, `hydrate`), `src/renderer/src/App.tsx` (left `DockHost` → `<main>` → right `DockHost`)
- `src/main/index.ts` — `will-attach-webview` (`delete prefs.preload`, `nodeIntegration = false`) and
  `will-navigate` + `GUEST_HOST_ALLOW`
- `src/renderer/src/yt/playerSingleton.test.ts` (T1–T7, T10, T11),
  `src/renderer/src/yt/usePlayerState.test.tsx` (T8, T12),
  `src/renderer/src/yt/inject/youtube-guest.test.ts` (T9), `tests/yt-fake-guest.ts`,
  `scripts/thread-smoke.mjs` (`SMOKE_FORCE_SWAP`)
- Commits: `47a05f7` (early reveal, shipped), `1863ffa` (its revert), `4ab51f0` (the B5 lift that
  created the two-pane shape)
- `docs/specs/v0.8.3-player-transport.md` §4 (contracts C1–C6), §5.3–§5.6, §6, §7, §8.2, §10;
  `docs/plans/v0.8.3-player-transport.md` Tasks 4–9
- `adrs/0016-webview-youtube-player.md` D7/D8/D9 (injection mechanism, the security clamp, the guest
  as a hand-authored string), `adrs/0064-shared-transport-state.md` § Consequences (the
  `SMOKE_PLAYBACK=1` bullet — the observation this milestone closed; **not** superseded)
- Issues: utof/linsae#213, #211, #65, #212, #218
- Electron `v42.5.0`, all read at the tag:
  `shell/browser/api/electron_api_web_contents.cc` — `WebContents::DidStartNavigation` emits
  unconditionally; `WebContents::DidFinishNavigation` early-returns on `!HasCommitted()`:
  https://github.com/electron/electron/blob/v42.5.0/shell/browser/api/electron_api_web_contents.cc
- `lib/renderer/web-view/web-view-attributes.ts` — `SrcAttribute.parse()`'s
  `guestInstanceId == null` early return and the same-value `MutationObserver`:
  https://github.com/electron/electron/blob/v42.5.0/lib/renderer/web-view/web-view-attributes.ts
- `lib/renderer/web-view/web-view-impl.ts` — `beforeFirstNavigation`, `createGuest()` →
  `attachGuestInstance`, and `dispatchEvent`'s `Object.assign(new Event(name), props)`:
  https://github.com/electron/electron/blob/v42.5.0/lib/renderer/web-view/web-view-impl.ts
- `lib/browser/web-view-events.ts` — the forwarded `<webview>` event list, including
  `dom-ready`, `did-start-navigation` and `render-process-gone`:
  https://github.com/electron/electron/blob/v42.5.0/lib/browser/web-view-events.ts
