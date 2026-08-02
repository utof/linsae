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

/** Fixed nonce for the host→guest port transfer (spec §4.1). Not secret; just unique. */
const NONCE = 'mx-port-7f3a9'

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
 * Only `readyTimeoutMs` has a consumer at this commit (the cover timer). The rest are
 * specified here whole because the handshake rewrite they bound lands in the next task and
 * splitting the object across two commits would leave the spec's §5.1 half-true in both.
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
let rpc: Rpc | null = null
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

/**
 * Called on 'dom-ready': inject the guest runtime and transfer the port.
 * Guard: if rpc is already live (dom-ready can fire more than once across SPA nav),
 * skip re-initialisation to avoid double-hooking.
 */
async function onDomReady(): Promise<void> {
  const wv = webview
  if (rpc || !wv) return

  const { port1, port2 } = new MessageChannel()
  rpc = createRpc(port1)

  rpc.on('state', (f) => {
    applyState(f as VideoFlags & { currentTime: number; duration: number })
  })
  rpc.on('time', (t) => {
    const o = t as { currentTime: number; duration: number }
    cache.currentTime = o.currentTime
    if (o.duration > 0) cache.duration = o.duration
  })
  // The cover's `ready` half — whichever of this and `armCoverTimer`'s timer comes first
  // wins (spec §5.6). Registered here with the `state`/`time` listeners because it belongs
  // to the same channel and must travel with them; `whenReady()` short-circuits on a
  // `ready` it has already seen, so attaching it late cannot miss one.
  void rpc.whenReady().then(dropCover)

  await safeExec(guestRuntime(NONCE))
  try {
    wv.contentWindow.postMessage(NONCE, '*', [port2])
  } catch (e) {
    console.warn('[player] port transfer failed', e)
  }
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
    // A document committed, so the cover's deadline restarts with it. Armed OUTSIDE the
    // handshake on purpose: it has to survive every way the handshake can end, including
    // the ones that end well (spec §5.6 / N6, and `armCoverTimer`).
    armCoverTimer()
    void onDomReady()
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
      void rpc?.invoke('pause')
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
  rpc?.destroy()
  rpc = null
  // A live cover timer outliving the singleton is a documented flake generator: it crosses
  // `afterEach` and fires into the next test's world (spec §5.8).
  clearCoverTimer()
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
  cache = { currentTime: 0, duration: null, last: 'unstarted' }
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
