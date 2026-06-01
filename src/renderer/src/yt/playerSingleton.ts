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
}

/** Fixed nonce for the host→guest port transfer (spec §4.1). Not secret; just unique. */
const NONCE = 'mx-port-7f3a9'

const timeout = (ms: number) => new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), ms))

// ── module-level singletons ──────────────────────────────────────────────────

let wrapper: HTMLDivElement | null = null
let webview: WebviewElement | null = null
let cover: HTMLDivElement | null = null
let clickCatcher: HTMLDivElement | null = null
let rpc: Rpc | null = null
let videoId: string | null = null
let cache: { currentTime: number; duration: number | null; last: PlayerState } = {
  currentTime: 0,
  duration: null,
  last: 'unstarted',
}
const stateCbs = new Set<(s: PlayerState) => void>()
let isPlaying = false
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

function applyState(f: VideoFlags & { currentTime: number; duration: number }): void {
  cache.currentTime = f.currentTime
  if (f.duration > 0) cache.duration = f.duration
  const s = deriveState(f)
  isPlaying = s === 'playing'
  if (s !== cache.last) {
    cache.last = s
    stateCbs.forEach((cb) => {
      cb(s)
    })
  }
}

/**
 * Grant a user gesture so the renderer allows autoplay (spec §D6).
 * Electron's autoplayPolicy=user-gesture-required blocks video.play() unless the call
 * originates from a user gesture; executeJavaScript(..., true) injects the gesture flag.
 */
function userGesture(): Promise<unknown> {
  return safeExec('1', true)
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
  rpc.on('needs-interaction', (payload) => {
    // When the consent/sign-in wall is active, let clicks reach the webview.
    // When cleared, the overlay reclaims clicks + keyboard focus (spec §8).
    if (clickCatcher)
      clickCatcher.style.pointerEvents = (payload as { active: boolean }).active ? 'none' : 'auto'
  })

  await safeExec(guestRuntime(NONCE))
  try {
    wv.contentWindow.postMessage(NONCE, '*', [port2])
  } catch (e) {
    console.warn('[player] port transfer failed', e)
  }

  await Promise.race([rpc.whenReady(), timeout(10000)])

  if (cover) cover.style.display = 'none'
  if (clickCatcher) clickCatcher.style.pointerEvents = 'auto'
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
  // ThreadView's normal content but below every overlay (CommandPalette=100,
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
  cover.style.cssText = 'position:absolute;inset:0;background:#000;z-index:2;pointer-events:none;'

  clickCatcher = document.createElement('div')
  clickCatcher.style.cssText =
    'position:absolute;inset:0;z-index:3;cursor:pointer;pointer-events:auto;'
  clickCatcher.onclick = () => {
    if (isPlaying) {
      void rpc?.invoke('pause')
    } else {
      void userGesture().then(() => rpc?.invoke('play'))
    }
  }

  // Re-inject the chrome-hiding CSS each time the page (re)loads. insertCSS is
  // guarded — a teardown/navigation race must never crash the main process.
  webview.addEventListener('did-start-loading', () => {
    void webview?.insertCSS(CLEAN_CSS).catch((e) => {
      console.warn('[player] insertCSS failed', e)
    })
  })
  webview.addEventListener('dom-ready', () => {
    void onDomReady()
  })

  wrapper.appendChild(webview)
  wrapper.appendChild(cover)
  wrapper.appendChild(clickCatcher)
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
      if (cover) cover.style.display = 'block'
      webviewEl.src = watchUrl(id)
    },

    async play(): Promise<void> {
      await userGesture()
      await rpc?.invoke('play')
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

    destroy() {
      destroyPlayer()
    },
  }

  return instance
}

/**
 * Tears down the singleton (test cleanup + app teardown).
 * Why: called by destroy() and by usePlayer cleanup on HMR / test afterEach.
 */
export function destroyPlayer(): void {
  rpc?.destroy()
  rpc = null
  if (syncRaf) {
    cancelAnimationFrame(syncRaf)
    syncRaf = 0
  }
  wrapper?.remove()
  wrapper = null
  webview = null
  cover = null
  clickCatcher = null
  videoId = null
  host = null
  lastRectKey = ''
  cache = { currentTime: 0, duration: null, last: 'unstarted' }
  isPlaying = false
  stateCbs.clear()
  instance = null
}
