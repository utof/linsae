/**
 * Module-level webview player singleton. Replaces the Vidstack engine (ADR 0016 / spec §4.1).
 *
 * WHY singleton + detached wrapper (unchanged from the Vidstack design):
 *   React 19 StrictMode double-invokes mount effects (mount → unmount → mount) in dev.
 *   A player owned by the React tree would be torn down and rebuilt on that cycle,
 *   reloading the YouTube page. We keep the player OUTSIDE React: a stable wrapper <div>
 *   lives at module scope, the <webview> is created into it once (the `instance` guard
 *   returns the existing player), and usePlayer only re-parents the wrapper into the
 *   ThreadView DOM on mount. (ADR 0012)
 *
 * WHY <webview> not <iframe>:
 *   <iframe> with the YouTube IFrame API cannot remove YouTube's chrome by contract.
 *   <webview> loads the full youtube.com/watch page; we inject a guest runtime via
 *   executeJavaScript + a MessagePort RPC to control the in-page <video> directly and
 *   hide chrome via insertCSS. This lets the Skip-Ad button remain interactive (spec §4.4).
 *   (ADR 0016 / spec §4 rationale)
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
  setUserAgent(ua: string): void
  contentWindow: Window
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
let instance:
  | (Player & {
      wrapper: HTMLDivElement
      videoId: string | null
      getMediaRect(): DOMRect | null
    })
  | null = null

// ── internal helpers ─────────────────────────────────────────────────────────

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
 * Why: Electron's autoplayPolicy=user-gesture-required blocks video.play() unless
 * the call originates from a user gesture. executeJavaScript(..., true) injects
 * the gesture flag into the webview's renderer process.
 */
function userGesture(): Promise<unknown> {
  return webview!.executeJavaScript('1', true)
}

/**
 * Called on 'dom-ready': inject the guest runtime and transfer the port.
 * Guard: if rpc is already live (dom-ready can fire more than once across SPA nav),
 * skip re-initialisation to avoid double-hooking.
 */
async function onDomReady(): Promise<void> {
  if (rpc) return
  const wv = webview
  if (!wv) return

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

  await wv.executeJavaScript(guestRuntime(NONCE))
  wv.contentWindow.postMessage(NONCE, '*', [port2])

  await Promise.race([rpc.whenReady(), timeout(10000)])

  if (cover) cover.style.display = 'none'
  if (clickCatcher) clickCatcher.style.pointerEvents = 'auto'
}

// ── public API ────────────────────────────────────────────────────────────────

/**
 * Returns the singleton player, constructing the detached wrapper + webview on first call.
 * @see src/renderer/src/yt/usePlayer.ts (re-parents the wrapper into the ThreadView DOM)
 * Why: ADR 0012 + ADR 0016
 */
export function getPlayer(): Player & {
  wrapper: HTMLDivElement
  videoId: string | null
  getMediaRect(): DOMRect | null
} {
  if (instance) return instance

  wrapper = document.createElement('div')
  wrapper.id = 'yt-player-wrapper'
  wrapper.style.cssText = 'width:100%;height:100%;position:relative;'

  webview = document.createElement('webview') as unknown as WebviewElement
  webview.setAttribute('partition', 'persist:yt-player')
  webview.setAttribute('webpreferences', 'autoplayPolicy=user-gesture-required')
  webview.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;border:0;'
  webview.setUserAgent(youtubeUserAgent())

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

  webview.addEventListener('did-start-loading', () => {
    void webview!.insertCSS(CLEAN_CSS)
  })
  webview.addEventListener('dom-ready', () => {
    void onDomReady()
  })

  wrapper.appendChild(webview)
  wrapper.appendChild(cover)
  wrapper.appendChild(clickCatcher)

  const wrapperEl = wrapper
  const webviewEl = webview

  instance = {
    get wrapper() {
      return wrapperEl
    },
    get videoId() {
      return videoId
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
      await userGesture()
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
  wrapper?.remove()
  wrapper = null
  webview = null
  cover = null
  clickCatcher = null
  videoId = null
  cache = { currentTime: 0, duration: null, last: 'unstarted' }
  isPlaying = false
  stateCbs.clear()
  instance = null
}
