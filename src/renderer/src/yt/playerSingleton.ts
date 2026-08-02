/**
 * Module-level webview player singleton. Replaces the Vidstack engine (ADR 0016 / spec §4.1).
 *
 * WHY the webview is mounted ONCE and never re-parented (changed from the iframe design):
 *   Moving a <webview> in the DOM (re-parenting it, or unmounting/remounting an ancestor)
 *   makes Electron DESTROY and recreate its guest WebContents — invalidating the
 *   guestInstanceId (→ "Invalid guestInstanceId" in GUEST_VIEW_MANAGER_CALL) and reloading
 *   the page (→ a fresh youtube.com/watch load that redirects through the consent wall to the
 *   home page). See electron/electron#9529 and #7700. The old iframe singleton survived
 *   re-parenting; a <webview> does not. So we attach the wrapper to <body> ONCE and POSITION
 *   it (position:fixed, bounds synced each frame to the ThreadView host placeholder) instead
 *   of moving it. media-extended v3 (our MIT reference) likewise never re-parents its webview.
 *   StrictMode's mount→unmount→mount, the layout toggle, and (future) drag-to-move all just
 *   re-point the sync at a placeholder / park the wrapper off-screen — the element is never
 *   detached or display:none'd (both can destroy the guest, electron#7700), so the guest
 *   persists and the page never reloads except on an actual videoId change. (ADR 0012 / 0016)
 *
 * WHY <webview> not <iframe>:
 *   <iframe> with the YouTube IFrame API cannot remove YouTube's chrome by contract.
 *   <webview> loads the full youtube.com/watch page; we inject a guest runtime via
 *   executeJavaScript + a MessagePort RPC to control the in-page <video> directly and
 *   hide chrome via insertCSS, keeping the Skip-Ad button interactive (spec §4.4). (ADR 0016)
 */

import type { Player, PlayerState } from '../../../shared/player'
import { CLEAN_CSS } from './inject/clean-css'
import { guestRuntime } from './inject/youtube-guest'
import { deriveState, type VideoFlags } from './player-state'
import { createRpc, type Rpc } from './rpc'
import { youtubeUserAgent } from './ua'
import { watchUrl } from './watch-url'

/** Typed shape of the Electron <webview> element (not in lib.dom.d.ts). */
interface WebviewElement extends HTMLElement {
  src: string
  executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>
  insertCSS(css: string): Promise<string>
  removeInsertedCSS(key: string): Promise<void>
  contentWindow: Window
  /** The guest's current URL — the payload of the C6 diagnostic (spec §5.1). */
  getURL(): string
}

/** The extra (non-Player) members the singleton exposes. */
type PlayerInstance = Player & {
  wrapper: HTMLDivElement
  videoId: string | null
  getMediaRect(): DOMRect | null
  /** Show the player and start syncing its bounds to `hostEl`. */
  mount(hostEl: HTMLElement): void
  /** Hide the player and stop syncing (the guest persists; no reload). */
  unmount(): void
  /** Toggle YouTube's own (native) fullscreen from inside the guest. */
  toggleFullscreen(): void
}

/**
 * Stem of the host→guest handshake token (spec §4.1). Not secret; just unique.
 *
 * Not the gate on its own any more: each attempt sends `${NONCE}:${seq}` so that an ack can
 * be matched to the attempt that is still current, and a late one from a superseded attempt
 * or a dead document is inert rather than publishing a channel (contract C4, spec §5.5).
 */
const NONCE = 'mx-port-7f3a9'

/**
 * Pause the guest's <video> without the RPC, for the window where there is no channel to
 * invoke on (spec §5.9). Same selector as `play()`'s snippet; no user gesture needed.
 */
const PAUSE_JS = "var v=document.querySelector('#movie_player video');if(v){v.pause();}"

/**
 * Timing + retry bounds for the guest handshake, exported as a MUTABLE object so tests can
 * shrink them. Mirrors `createRpc`'s `opts.invokeTimeoutMs` — the existing precedent in this
 * area for making a timing constant injectable.
 *
 * Why an exported mutable object rather than parameters: the handshake is driven by the
 * webview's own DOM events, not by callers, so there is no call site to thread options
 * through. The cost is shared module state, so **tests MUST save and restore any field they
 * change** — a shrunk timeout left behind is visible to every later test in the file, and
 * under `isolate: false` to later files too.
 *
 * `armWatchdogMs` is the one field with no consumer at this commit — the navigation watchdog
 * it bounds lands with the `did-start-navigation` listener (spec §5.3). The object is
 * specified whole because splitting it across commits would leave the spec's §5.1 half-true
 * in both.
 *
 * @see docs/specs/v0.8.3-player-transport.md §5.1
 * @issue utof/linsae#213
 */
export const handshakeConfig = {
  ackTimeoutMs: 3000,
  maxAttempts: 3,
  readyTimeoutMs: 10_000,
  armWatchdogMs: 4000,
  retryBackoffMs: 250,
}

// ── module-level singletons ──────────────────────────────────────────────────

let wrapper: HTMLDivElement | null = null
let webview: WebviewElement | null = null
let cover: HTMLDivElement | null = null
let spinner: HTMLDivElement | null = null
// Key returned by the last CLEAN_CSS insertCSS, so setYoutubeChrome can removeInsertedCSS it.
let cssKey: string | null = null
// PUBLISHED: acked by the guest document that is currently committed, and by contract C1
// non-null on no other terms. Everything below is what keeps that true (spec §5.1).
let rpc: Rpc | null = null
// Half-built: a channel whose port has been transferred but whose ack has not arrived. Held
// in module state rather than only in `handshake()`'s closure so `teardown()` can destroy it
// — otherwise a candidate outlives the document it was built for, holding an open port.
let pendingRpc: Rpc | null = null
// Monotonic; names the attempt that is current. Every resume point in `handshake()` compares
// its own captured `seq` against this, which is how a superseded attempt learns it lost (C4).
let handshakeSeq = 0
// Retries within the CURRENT document — reset by `teardown()`, so `maxAttempts` is spent per
// document rather than per app run (spec §5.5).
let attempts = 0
// The C6 watchdog for a navigation that starts and never commits (spec §5.3). Cleared by
// `teardown()`; armed by the `did-start-navigation` listener that owns it.
let armWatchdog = 0
// The bounded unconditional cover drop (spec §5.6). `window.setTimeout` deliberately:
// the DOM overload returns a number, Node's returns a NodeJS.Timeout, and this file is
// typechecked against both libs (see the same note in `NoteBubble.tsx`).
let coverTimer = 0
let videoId: string | null = null
let cache: { currentTime: number; duration: number | null; last: PlayerState } = {
  currentTime: 0,
  duration: null,
  last: 'unstarted',
}
const stateCbs = new Set<(s: PlayerState) => void>()
// Position-sync state: `host` is the ThreadView placeholder the fixed wrapper tracks.
let host: HTMLElement | null = null
let syncRaf = 0
let lastRectKey = ''
let instance: PlayerInstance | null = null

// ── internal helpers ─────────────────────────────────────────────────────────

/** Guarded executeJavaScript — a teardown/navigation race must never crash the main process. */
async function safeExec(code: string, gesture?: boolean): Promise<unknown> {
  try {
    return await webview?.executeJavaScript(code, gesture)
  } catch (e) {
    console.warn('[player] executeJavaScript failed', e)
    return undefined
  }
}

/**
 * Guarded insertCSS. insertCSS calls getWebContentsId internally, which THROWS
 * synchronously unless the webview is attached AND dom-ready has fired — so a plain
 * .catch() isn't enough; we must try/catch the synchronous throw too. Only call this
 * from the 'dom-ready' handler (never 'did-start-loading', which fires too early).
 */
function safeInsertCSS(): void {
  try {
    void webview
      ?.insertCSS(CLEAN_CSS)
      .then((key) => {
        cssKey = key
      })
      .catch((e) => {
        console.warn('[player] insertCSS failed', e)
      })
  } catch (e) {
    console.warn('[player] insertCSS threw', e)
  }
}

function applyState(f: VideoFlags & { currentTime: number; duration: number }): void {
  cache.currentTime = f.currentTime
  if (f.duration > 0) cache.duration = f.duration
  const s = deriveState(f)
  if (s !== cache.last) {
    cache.last = s
    stateCbs.forEach((cb) => {
      cb(s)
    })
    refreshSpinner()
  }
}

/**
 * Drop the value cache back to "no guest has spoken yet" (#211 L1, spec §5.2 step 4).
 *
 * Deliberately does NOT notify `stateCbs`, and that is not an oversight: React consumers keep
 * the previous `state` until a real guest event arrives. It is safe because the guest's
 * `flags()` hard-codes `ready: true` (`inject/youtube-guest.ts`), so `deriveState` can never
 * return `'unstarted'` from a guest event — the reset value cannot collide with the incoming
 * video's first real state. Notifying here would instead flash every video change through a
 * synthetic `'unstarted'` that no guest ever sent.
 */
function resetCache(): void {
  cache = { currentTime: 0, duration: null, last: 'unstarted' }
}

/** Inject the spin keyframe into the HOST document once (the wrapper lives in host <body>). */
function ensureSpinnerStyle(): void {
  if (document.getElementById('yt-spinner-style')) return
  const st = document.createElement('style')
  st.id = 'yt-spinner-style'
  st.textContent = '@keyframes yt-spin{to{transform:rotate(360deg)}}'
  document.head.appendChild(st)
}

/**
 * Loading-spinner visibility: shown while the black `cover` is up (initial load) and while
 * `buffering` (seek-into-unbuffered / mid-play stalls) — both are otherwise a bare black
 * frame that reads as "broken". Lives in the wrapper (vanilla DOM), not React: the <webview>
 * paints above page content, so a React overlay would hide behind it.
 */
function refreshSpinner(): void {
  if (!spinner) return
  const coverUp = !!cover && cover.style.display !== 'none'
  spinner.style.display = coverUp || cache.last === 'buffering' ? 'block' : 'none'
}

/**
 * Cancel any pending unconditional drop. Every transition of the cover goes through this —
 * a timer that outlives the state it was armed for fires into someone else's document.
 */
function clearCoverTimer(): void {
  if (coverTimer) {
    clearTimeout(coverTimer)
    coverTimer = 0
  }
}

/**
 * Drop the black cover and re-sync the spinner.
 *
 * Do NOT move this earlier to shave the ~1s — in particular, do NOT key it on the
 * handshake's `ack`. That window deliberately masks YouTube's startup churn
 * (muted-autoplay → forced-unmute pause → chrome settling); revealing early (commit
 * 47a05f7) exposed it as a "muted, plays 1s, then stops" flash and was reverted. Fast+clean
 * reveal is tracked in #65. Spec §5.6 / N5.
 *
 * `refreshSpinner()` reads the cover's own `display`, so it must run AFTER the drop.
 */
function dropCover(): void {
  clearCoverTimer()
  if (cover) cover.style.display = 'none'
  refreshSpinner()
}

/**
 * Raise the cover for a video change, cancelling any drop still pending for the OLD one.
 *
 * The cancel is the whole point of routing this through a function: a timer armed for the
 * outgoing document keeps running across `load()`, and if it fires before the incoming
 * document's `dom-ready` re-arms it, it reveals the new video's startup churn — N5's
 * regression, arriving by the back door. Cover up ⇒ no drop pending, always.
 */
function raiseCover(): void {
  clearCoverTimer()
  if (cover) cover.style.display = 'block'
  refreshSpinner()
}

/**
 * Arm the cover's bounded UNCONDITIONAL drop for the document that just committed.
 *
 * Why unconditional, and why it is not the handshake's business: on a consent wall the
 * handshake SUCCEEDS (the transport is live and acks) while the guest never hooks a
 * `<video>`, so `ready` never arrives. A drop gated on the handshake's outcome therefore
 * fires on neither branch and the player stays permanently black over the very page the
 * user has to click. This timer is the escape hatch, and it is why the webview is left
 * interactive. Spec §5.6 / N6.
 */
function armCoverTimer(): void {
  clearCoverTimer()
  coverTimer = window.setTimeout(dropCover, handshakeConfig.readyTimeoutMs)
}

/** rAF loop: keep the fixed wrapper exactly over the ThreadView host placeholder. */
function syncBounds(): void {
  if (!wrapper) {
    syncRaf = 0
    return
  }
  if (host?.isConnected) {
    const r = host.getBoundingClientRect()
    const key = `${r.left}|${r.top}|${r.width}|${r.height}`
    if (key !== lastRectKey) {
      lastRectKey = key
      wrapper.style.left = `${r.left}px`
      wrapper.style.top = `${r.top}px`
      wrapper.style.width = `${r.width}px`
      wrapper.style.height = `${r.height}px`
    }
  }
  syncRaf = requestAnimationFrame(syncBounds)
}

// ── the guest handshake (spec §5.2 / §5.5) ───────────────────────────────────

/**
 * Invalidate every piece of guest-derived state — the single point where contract C2 is
 * enforced (spec §5.2). Called wherever the current document is going or already gone:
 * `dom-ready` (§5.4, a NEW one has committed, so the old channel is dead by definition) and
 * `destroyPlayer()` (§5.8).
 *
 * The order is load-bearing. `handshakeSeq++` goes first, so the instant this returns every
 * attempt still in flight is stale by construction and none of them can publish — each
 * compares its captured `seq` at every resume point. Then both channels are destroyed and
 * nulled: `pendingRpc` too, because a candidate whose ack never arrives would otherwise hold
 * an open port until its own deadline expires (up to `ackTimeoutMs`), which in the suite
 * crosses `afterEach`.
 *
 * `handshake()` can be suspended between injecting the guest and building a candidate (the
 * `await safeExec` of §5.5 step 1), so a candidate created AFTER this ran would survive it —
 * which is why step 2 re-checks `seq` after assigning `pendingRpc` rather than trusting this
 * sweep alone. See that comment for why the re-check is dead today and kept anyway.
 *
 * Both timers are cleared here rather than at the call sites, so no caller can forget one: a
 * timer that outlives the state it was armed for fires into someone else's document, and in
 * the suite it crosses `afterEach` into the next test's world (spec §5.8). The retry timer is
 * the deliberate exception — it is guarded rather than cleared, because `handshakeSeq` never
 * decreases, so a stale retry can only no-op. The cover itself
 * is left in whatever state it is in — `load()` raises it explicitly, and `dom-ready` re-arms
 * the drop straight after calling this.
 */
function teardown(): void {
  handshakeSeq++
  attempts = 0
  pendingRpc?.destroy()
  pendingRpc = null
  rpc?.destroy()
  rpc = null
  resetCache()
  if (armWatchdog) {
    clearTimeout(armWatchdog)
    armWatchdog = 0
  }
  clearCoverTimer()
}

/** Destroy an unpublished candidate and give up its claim on `pendingRpc` if it still holds it. */
function discard(candidate: Rpc): void {
  candidate.destroy()
  if (pendingRpc === candidate) pendingRpc = null
}

/**
 * The C6 diagnostic: exactly one `console.warn`, carrying the URL of the document the
 * handshake gave up on. Without it the player rests in a silent dead state — which is how
 * #213 survived two milestones, since `play()` bypasses the RPC and the chrome-hiding CSS
 * re-fires outside the handshake, so a dead channel looks like a working player.
 */
function onHandshakeFailed(): void {
  console.warn(
    `[player] handshake failed after ${handshakeConfig.maxAttempts} attempts on`,
    webview?.getURL(),
  )
}

/**
 * Re-enter the handshake after the backoff, unless this attempt has been superseded in the
 * meantime.
 *
 * The `seq` re-check is what stops a retry from outliving its document: `teardown()` bumps
 * `handshakeSeq`, so a timer armed by the outgoing document no-ops instead of injecting a
 * runtime into the incoming one (or, in the suite, into the next test's webview).
 */
function retryLater(seq: number): void {
  window.setTimeout(() => {
    if (seq !== handshakeSeq) return
    handshake().catch((e: unknown) => {
      console.warn('[player] handshake threw', e)
    })
  }, handshakeConfig.retryBackoffMs)
}

/**
 * `whenAck` raced against a deadline the caller owns (spec §5.5 step 4).
 *
 * The loser's timer is cancelled deliberately: `Promise.race` does not do it, and an
 * abandoned `ackTimeoutMs` timer per attempt outlives the handshake it bounded — at three
 * attempts a document that is already gone keeps a timer alive for seconds, and in the suite
 * that crosses `afterEach` (spec §5.8).
 *
 * `false` is resolved EXPLICITLY rather than falling out as `undefined`: `whenAck` never
 * resolves `false` (see `rpc.ts`), so the `false` arm of this race is always this timer, and
 * an implicit `undefined` would type the result as `boolean | undefined` and work by accident.
 */
function raceAck(candidate: Rpc, token: string): Promise<boolean> {
  let timer = 0
  const deadline = new Promise<boolean>((resolve) => {
    timer = window.setTimeout(() => {
      resolve(false)
    }, handshakeConfig.ackTimeoutMs)
  })
  return Promise.race([candidate.whenAck(token), deadline]).finally(() => {
    clearTimeout(timer)
  })
}

/**
 * Establish one channel with the guest document that is currently committed, and publish it
 * ONLY once that document has acknowledged it (contract C1, spec §5.5). Retries itself up to
 * `maxAttempts` per document; every exit either publishes, hands off to a retry, or is a
 * superseded attempt standing down for the one that replaced it.
 *
 * There is no `rpc` term in the entry check, and that is the fix for #213 rather than an
 * omission: `dom-ready` has already called `teardown()` (§5.4), so an `rpc` seen here could
 * only belong to a document that is provably gone. HEAD's `if (rpc || !wv) return` is exactly
 * the guard that let a consent wall's channel refuse the real watch page forever.
 *
 * @issue utof/linsae#213
 */
async function handshake(): Promise<void> {
  const wv = webview
  if (!wv) return
  if (attempts++ >= handshakeConfig.maxAttempts) return void onHandshakeFailed()

  // Per-attempt, so an ack can be matched to the attempt that sent it (C4). `attempts` is
  // bounded per document; `handshakeSeq` is monotonic for the life of the module.
  const seq = ++handshakeSeq
  const token = `${NONCE}:${seq}`

  // 1. Inject the guest runtime, armed for this token.
  await safeExec(guestRuntime(token))
  if (seq !== handshakeSeq) return

  // 2. Build the channel into `pendingRpc`, NEVER into `rpc` — publishing here is #213's
  //    narrow half, where the guest swaps documents before the transfer and leaves a
  //    non-null `rpc` holding an orphaned port.
  const { port1, port2 } = new MessageChannel()
  const candidate = createRpc(port1)
  pendingRpc = candidate
  // Spec §5.2 step 3 / §5.5 step 2 mandate this re-check. It cannot fire TODAY: the check
  // after `safeExec` above already closed that window, and everything between there and here
  // is synchronous (`new MessageChannel()` and `createRpc`'s `port.start?.()` never yield).
  // It is kept because it stops being dead the moment anyone inserts an await into step 2 —
  // at which point a `teardown()` would sweep a `pendingRpc` this candidate did not yet exist
  // to be, and the candidate would outlive the teardown meant to kill it.
  if (seq !== handshakeSeq) return void discard(candidate)

  // 3. Transfer. `contentWindow` throws when the guest has gone away, and this runs inside a
  //    promise, so an uncaught throw here becomes an unhandled rejection.
  try {
    wv.contentWindow.postMessage(token, '*', [port2])
  } catch (e) {
    console.warn('[player] port transfer failed', e)
    discard(candidate)
    retryLater(seq)
    return
  }

  // 4. Wait for the guest to acknowledge THIS attempt, bounded by our own deadline.
  const acked = await raceAck(candidate, token)

  // 5. Two conditions, deliberately NOT merged into one retry. A superseded attempt must
  //    stand down silently: retrying it would re-arm the guest with a new token, and the
  //    guest's `initPort` destroys its prior rpc — killing the guest end of a channel the
  //    host has already published and leaving `rpc` non-null with a dead peer. That is
  //    precisely the state C1 exists to make impossible.
  if (seq !== handshakeSeq) return void discard(candidate)
  if (!acked) {
    discard(candidate)
    retryLater(seq)
    return
  }

  // 6. Publish. The cover is NOT touched here — it keys on `ready`-or-timeout and never on
  //    `ack` (N5/C3, see `dropCover`); what moves here is only the `whenReady` hook, which
  //    must not fire for a candidate that never becomes the channel.
  pendingRpc = null
  rpc = candidate
  candidate.on('state', (f) => {
    applyState(f as VideoFlags & { currentTime: number; duration: number })
  })
  candidate.on('time', (t) => {
    const o = t as { currentTime: number; duration: number }
    cache.currentTime = o.currentTime
    if (o.duration > 0) cache.duration = o.duration
  })
  // Registered with the `state`/`time` listeners because it belongs to the same channel and
  // must travel with it; `whenReady()` short-circuits on a `ready` it has already seen, so
  // attaching it at publish cannot miss one (spec §5.6).
  void candidate.whenReady().then(dropCover)
}

// ── public API ────────────────────────────────────────────────────────────────

/**
 * Returns the singleton player, constructing the wrapper + webview (attached to <body>
 * ONCE) on first call. `usePlayer` calls mount()/unmount() to show/hide + position it.
 * @see src/renderer/src/yt/usePlayer.ts
 * Why: ADR 0012 + ADR 0016
 */
export function getPlayer(): PlayerInstance {
  if (instance) return instance

  wrapper = document.createElement('div')
  wrapper.id = 'yt-player-wrapper'
  // position:fixed + bounds synced to the host (syncBounds). z-index:1 sits above
  // ThreadView's normal content but below every overlay (command palettes=100,
  // BacklinksPane=10, modals/meters≥1000). Parked OFF-SCREEN (not display:none) until
  // mounted — display/visibility changes can clear a <webview> guestInstanceId
  // (electron#7700); off-screen keeps the guest alive.
  wrapper.style.cssText =
    'position:fixed;left:-99999px;top:0;width:640px;height:360px;z-index:1;overflow:hidden;background:#000;'

  webview = document.createElement('webview') as unknown as WebviewElement
  webview.setAttribute('partition', 'persist:yt-player')
  webview.setAttribute('webpreferences', 'autoplayPolicy=user-gesture-required')
  // Why the `useragent` attribute (not setUserAgent()): setUserAgent() requires the webview
  // attached + dom-ready (it calls getWebContentsId internally); the attribute is read at
  // WebContents creation time and needs no attachment. (bug found by T7 smoke)
  webview.setAttribute('useragent', youtubeUserAgent())
  webview.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;border:0;'

  cover = document.createElement('div')
  // A handle, purely so tests can reach the cover by name: it is one of two anonymous
  // <div>s in a three-child wrapper, and a positional query silently retargets the moment
  // that order changes. Nothing styles or scripts it by id. (Same for the spinner below.)
  cover.id = 'yt-player-cover'
  cover.style.cssText = 'position:absolute;inset:0;background:#000;z-index:2;pointer-events:none;'

  // Loading spinner: a Figma-blue (#0D99FF) arc on a translucent track, centered over the
  // player. A full circle is fine here — a spinner is inherently round, not a "shape" in the
  // sharp-by-default sense. z-index:3 sits above the cover; pointer-events:none keeps the
  // webview interactive. Visibility is driven by refreshSpinner() off the player state.
  ensureSpinnerStyle()
  spinner = document.createElement('div')
  spinner.id = 'yt-player-spinner'
  spinner.style.cssText =
    'position:absolute;top:50%;left:50%;width:40px;height:40px;margin:-20px 0 0 -20px;box-sizing:border-box;border-radius:50%;border:3px solid rgba(255,255,255,0.18);border-top-color:#0D99FF;animation:yt-spin 0.8s linear infinite;z-index:3;pointer-events:none;display:none;'

  // No click-catcher overlay: the webview stays fully interactive so the user can
  // dismiss YouTube's consent / sign-in walls and use native click-to-toggle. The
  // TransportBar drives play/pause/seek over the RPC. Trade-off: a focused webview
  // can swallow host hotkeys — accepted for v1 (spec §8 follow-up).
  webview.addEventListener('dom-ready', () => {
    // insertCSS must wait for dom-ready (it calls getWebContentsId, which throws synchronously
    // before then — that was the 'did-start-loading' crash). Skipped when the "show full
    // YouTube UI" debug toggle is on; re-applies on every (re)load otherwise. The cover is
    // NOT dropped here — see `dropCover`.
    if (!isYoutubeChromeShown()) safeInsertCSS()
    // A committed `dom-ready` is the DEFINITIVE signal that the previous document is gone,
    // where `did-start-navigation` is only an early warning that may never commit — so this
    // is the authoritative invalidation point, and it runs BEFORE the cover is re-armed
    // (`teardown()` clears that timer) and before the handshake (spec §5.4).
    teardown()
    // A document committed, so the cover's deadline restarts with it. Armed OUTSIDE the
    // handshake on purpose: it has to survive every way the handshake can end, including
    // the ones that end well (spec §5.6 / N6, and `armCoverTimer`).
    armCoverTimer()
    // `.catch()` rather than `void`: the handshake body has several throw sites now, and an
    // unhandled rejection fails the suite in whichever file happens to be running.
    handshake().catch((e: unknown) => {
      console.warn('[player] handshake threw', e)
    })
  })

  wrapper.appendChild(webview)
  wrapper.appendChild(cover)
  wrapper.appendChild(spinner)
  // Attach ONCE to <body> and never move it again (see header / electron#9529).
  document.body.appendChild(wrapper)

  const wrapperEl = wrapper
  const webviewEl = webview

  instance = {
    get wrapper() {
      return wrapperEl
    },
    get videoId() {
      return videoId
    },

    mount(hostEl: HTMLElement): void {
      host = hostEl
      lastRectKey = '' // force a reposition over the host on the next frame
      if (!syncRaf) syncRaf = requestAnimationFrame(syncBounds)
    },

    unmount(): void {
      host = null
      if (syncRaf) {
        cancelAnimationFrame(syncRaf)
        syncRaf = 0
      }
      // Park off-screen rather than display:none — display/visibility changes can
      // clear a <webview>'s guestInstanceId (electron#7700); off-screen keeps the
      // guest alive. Pause so audio doesn't keep playing while the view is hidden.
      wrapperEl.style.left = '-99999px'
      wrapperEl.style.top = '0px'
      // The fallback is not belt-and-braces: `rpc` is null for as long as the handshake is
      // still running (up to `maxAttempts × ackTimeoutMs`), and closing the pane in that
      // window used to leave the video AUDIBLE with nothing on screen (spec §5.9).
      // `.catch` because `invoke` rejects on its own 1000ms deadline (`createRpc`'s timer),
      // and a bare `void` attaches no handler — reachable whenever a published channel's peer
      // has gone away without a `dom-ready` to tear it down.
      if (rpc)
        void rpc.invoke('pause').catch(() => {
          /* peer already gone; the pane is closing anyway */
        })
      else void safeExec(PAUSE_JS)
    },

    async load(id: string): Promise<void> {
      if (id === videoId) return
      videoId = id
      rpc?.destroy()
      rpc = null
      raiseCover()
      webviewEl.src = watchUrl(id)
    },

    async play(): Promise<void> {
      // Play DIRECTLY in the guest with a user gesture (executeJavaScript's 2nd arg).
      // Routing play through the RPC port lost the gesture — the port message is a
      // separate task, so by the time the guest called video.play() the transient
      // activation was gone and autoplayPolicy=user-gesture-required silently blocked it
      // (the play button looked dead). pause/seek/rate need no gesture, so they stay on RPC.
      await safeExec(
        "var p=document.getElementById('movie_player');if(p&&p.unMute){p.unMute();}var v=document.querySelector('#movie_player video');if(v){v.muted=false;v.play().catch(function(){});}",
        true,
      )
    },

    async pause(): Promise<void> {
      await rpc?.invoke('pause')
    },

    async seekTo(s: number): Promise<void> {
      await rpc?.invoke('seekTo', s)
    },

    async getCurrentTime(): Promise<number> {
      return cache.currentTime
    },

    async getDuration(): Promise<number | null> {
      return cache.duration
    },

    async setPlaybackRate(r: number): Promise<void> {
      await rpc?.invoke('setRate', r)
    },

    onStateChange(cb: (s: PlayerState) => void): () => void {
      stateCbs.add(cb)
      return () => {
        stateCbs.delete(cb)
      }
    },

    getMediaRect(): DOMRect | null {
      return webviewEl ? webviewEl.getBoundingClientRect() : null
    },

    toggleFullscreen(): void {
      // Drive YouTube's OWN fullscreen button instead of fullscreening the host wrapper.
      // Native fullscreen lifts #movie_player into the browser top layer, escaping the
      // ancestor stacking context that traps its fixed-fill in-page (which let the page
      // chrome paint over the video when we fullscreened the wrapper). The userGesture
      // flag (executeJavaScript's 2nd arg) supplies the transient activation the
      // Fullscreen API requires — the host's button click doesn't carry into the guest.
      void safeExec(
        "var b=document.querySelector('#movie_player .ytp-fullscreen-button');if(b){b.click();}",
        true,
      )
    },

    destroy() {
      destroyPlayer()
    },
  }

  return instance
}

/**
 * Toggle whether the player `<webview>` receives pointer events.
 *
 * Set `false` for the DURATION OF A DIVIDER DRAG. The `<webview>` is an out-of-process
 * frame (OOPIF): when the cursor crosses into it, its guest process captures the OS
 * mouse stream, so the window-level `pointermove`/`pointerup` listeners that drive the
 * ThreadView resize handles stop firing — the drag freezes, and the `pointerup` that
 * happens over the webview never reaches the teardown, leaving the drag "stuck until
 * the next click". `pointer-events:none` on the wrapper lets the cursor pass through to
 * the host page so those window listeners keep firing across the whole viewport.
 * ALWAYS restore (`true`) on drag end.
 *
 * @see src/renderer/src/thread/ThreadView.tsx (onResizeStart / onSplitResizeStart)
 */
export function setPlayerInteractive(on: boolean): void {
  if (wrapper) wrapper.style.pointerEvents = on ? '' : 'none'
}

/**
 * Tears down the singleton (test cleanup + app teardown).
 * Why: called by destroy() and by usePlayer cleanup on HMR / test afterEach.
 */
export function destroyPlayer(): void {
  // Both channels, both timers, the sequence, the attempt count and the cache — leaving any
  // of them behind is the spec §5.8 hazard: an in-flight handshake still awaiting its ack
  // outlives the singleton and lands in the next test's world.
  teardown()
  if (syncRaf) {
    cancelAnimationFrame(syncRaf)
    syncRaf = 0
  }
  wrapper?.remove()
  wrapper = null
  webview = null
  cover = null
  spinner = null
  cssKey = null
  videoId = null
  host = null
  lastRectKey = ''
  stateCbs.clear()
  instance = null
}

/** localStorage key for the Settings "show full YouTube UI" debug toggle. */
const SHOW_CHROME_KEY = 'linsae.ytShowChrome'

/**
 * Whether the user opted to show YouTube's full page chrome in the player (debug). Default
 * false → chrome is hidden by CLEAN_CSS. Read on every dom-ready to gate the CSS injection.
 */
export function isYoutubeChromeShown(): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(SHOW_CHROME_KEY) === '1'
  } catch {
    return false
  }
}

/**
 * Toggle YouTube's full page chrome in the player (debug, from Settings). Persists the choice
 * and applies it to the live webview — remove the chrome-hiding CSS when showing, re-insert it
 * when hiding. The next video load also honours the pref via the dom-ready handler.
 */
export function setYoutubeChrome(show: boolean): void {
  try {
    localStorage.setItem(SHOW_CHROME_KEY, show ? '1' : '0')
  } catch {
    /* localStorage unavailable */
  }
  if (show) {
    if (cssKey && webview) {
      const key = cssKey
      cssKey = null
      void webview.removeInsertedCSS(key).catch((e) => {
        console.warn('[player] removeInsertedCSS failed', e)
      })
    }
  } else if (!cssKey) {
    safeInsertCSS()
  }
}
