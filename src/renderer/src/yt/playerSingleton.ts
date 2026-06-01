/**
 * Module-level Vidstack player singleton. Replaces the previous youtube-player
 * (sister.js) engine. See adrs/0015-youtube-embed-vidstack.md.
 *
 * WHY a singleton + detached wrapper (unchanged from the youtube-player design):
 *   React 19 StrictMode double-invokes mount effects (mount -> unmount -> mount) in
 *   dev. A player owned by the React tree would be torn down and rebuilt on that
 *   cycle, reloading the YouTube iframe. We keep the player OUTSIDE React: a stable
 *   wrapper <div> lives at module scope, the Vidstack player is created into it once
 *   (the `instance` guard returns the existing player), and usePlayer only re-parents
 *   the wrapper into the ThreadView DOM on mount.
 *
 * WHY Vidstack via `VidstackPlayer.create` and NOT the React <MediaPlayer> component:
 *   <MediaPlayer> is a React component -> lives in the tree -> reintroduces the
 *   StrictMode teardown above. The vanilla constructor lets us own the element
 *   imperatively, matching the proven pattern.
 *     - create() + import path: https://github.com/vidstack/player/discussions/1220
 *     - instance API (play/pause/subscribe/state/currentTime/playbackRate/src):
 *       https://vidstack.io/docs/player/components/core/player/
 *     - subscribe without renders:
 *       https://vidstack.io/docs/player/core-concepts/state-management/
 *
 * WHY this does NOT remove YouTube's chrome (title bar, "more videos", watermark):
 *   Vidstack's YouTube provider uses the YouTube IFrame API, which by contract cannot
 *   remove that chrome (https://vidstack.io/docs/player/api/providers/youtube/). We do
 *   not try. The injected CSS sets the iframe to pointer-events:none so the hover chrome
 *   never triggers; pause/end overlays are state-driven and sit behind our controls.
 *   This keeps us off the fragile DOM-selector + UA-spoof + CSP-bypass path
 *   media-extended v3 uses (ADR 0015 §Alternatives). The provider also hides the
 *   recommendations popup when custom controls are used.
 */
import { VidstackPlayer } from 'vidstack/global/player'

import type { Player, PlayerState } from '../../../shared/player'

// Derive the exact instance type from the constructor's return value instead of
// importing a type name that might move between Vidstack versions.
type VidstackInstance = Awaited<ReturnType<typeof VidstackPlayer.create>>

// The Vidstack state object passed to `player.subscribe`. We only read a handful of
// fields; this loose shape documents which ones (full list in the Player State docs).
interface MediaState {
  ended: boolean
  playing: boolean
  waiting: boolean
  started: boolean
  canPlay: boolean
  paused: boolean
  currentTime: number
  duration: number
}

let wrapper: HTMLDivElement | null = null
let styleEl: HTMLStyleElement | null = null
let createPromise: Promise<VidstackInstance> | null = null
let player: VidstackInstance | null = null
let videoId: string | null = null
let instance:
  | (Player & {
      wrapper: HTMLDivElement
      getIframeRect(): DOMRect | null
      videoId: string | null
    })
  | null = null

/**
 * Maps Vidstack's boolean state to the legacy YouTube-style PlayerState union the rest
 * of the app consumes. Order matters. The unstarted/cued/buffering boundaries are an
 * approximation of YouTube's discrete codes (-1 unstarted, 3 buffering, 5 cued).
 */
function deriveState(s: MediaState): PlayerState {
  if (s.ended) return 'ended'
  if (s.playing) return 'playing'
  if (s.waiting) return 'buffering'
  if (s.started) return 'paused' // started, not playing, not ended
  if (s.canPlay) return 'cued' // loaded & ready, never played
  return 'unstarted' // nothing loaded / not ready yet
}

/** Resolves once the async-created Vidstack player exists. */
function ready(): Promise<VidstackInstance> {
  if (player) return Promise.resolve(player)
  if (createPromise) return createPromise
  throw new Error('getPlayer() must be called before using the player')
}

/** Injects the (one-time) CSS that sizes the iframe and disables its pointer events. */
function injectStyleOnce() {
  if (styleEl) return
  styleEl = document.createElement('style')
  styleEl.id = 'yt-player-wrapper-style'
  // Scoped by the wrapper id so we don't need a CSS framework (no Tailwind dep) and
  // don't have to observe the iframe's async creation. pointer-events:none is the key
  // line: YouTube receives no hover/click, so its hover chrome (top title+share bar,
  // related-on-hover) never appears; our overlay owns all input. See ADR 0015.
  styleEl.textContent = [
    '#yt-player-wrapper, #yt-player-wrapper media-player { width: 100%; height: 100%; }',
    '#yt-player-wrapper iframe { width: 100% !important; height: 100% !important; pointer-events: none; border: 0; }',
  ].join('\n')
  document.head.appendChild(styleEl)
}

/** Returns the singleton, constructing the detached wrapper + player on first call. */
export function getPlayer() {
  if (instance) return instance

  injectStyleOnce()

  wrapper = document.createElement('div')
  wrapper.id = 'yt-player-wrapper'
  const wrapperEl = wrapper // non-null capture for closures below

  // Kick off async creation. We pass the ELEMENT as target (a selector wouldn't
  // resolve while the wrapper is still detached). No `layout` -> no Vidstack default
  // UI (ThreadView draws our own TransportBar). `load: 'eager'` because the wrapper
  // starts detached and is re-parented into a custom scroll container, where the
  // default 'visible' IntersectionObserver strategy may never fire. See ADR 0015 §6.
  createPromise = VidstackPlayer.create({
    target: wrapperEl,
    load: 'eager',
    playsInline: true,
  }).then((p) => {
    player = p
    return p
  })

  instance = {
    wrapper: wrapperEl,
    get videoId() {
      return videoId
    },
    async load(id) {
      videoId = id
      const p = await ready()
      // `youtube/<id>` is the shorthand Vidstack's YouTube provider expects; a full
      // watch URL also works, so accept either.
      p.src = /^https?:\/\//.test(id) ? id : `youtube/${id}`
    },
    async play() {
      const p = await ready()
      await p.play()
    },
    async pause() {
      const p = await ready()
      await p.pause()
    },
    async seekTo(seconds) {
      const p = await ready()
      p.currentTime = seconds // setter performs the seek
    },
    async getCurrentTime() {
      const p = await ready()
      return p.state.currentTime ?? 0
    },
    async getDuration() {
      const p = await ready()
      const d = p.state.duration
      return d && d > 0 ? d : null
    },
    async setPlaybackRate(rate) {
      const p = await ready()
      p.playbackRate = rate
    },
    onStateChange(cb) {
      // `subscribe` fires on any state change and returns its own unsubscribe fn;
      // it does NOT trigger React renders. We dedupe so cb only fires on derived-state
      // transitions, matching the old per-YT-event behavior.
      let unsubscribe: (() => void) | null = null
      let cancelled = false
      ready().then((p) => {
        if (cancelled) return
        let last: PlayerState | null = null
        unsubscribe = p.subscribe((state: MediaState) => {
          const next = deriveState(state)
          if (next !== last) {
            last = next
            cb(next)
          }
        })
      })
      return () => {
        cancelled = true
        unsubscribe?.()
      }
    },
    getIframeRect() {
      const f = wrapperEl.querySelector('iframe')
      return f ? f.getBoundingClientRect() : null
    },
    destroy() {
      destroyPlayer()
    },
  }

  return instance
}

/** Tears down the singleton (test cleanup + app teardown). */
export function destroyPlayer(): void {
  try {
    player?.destroy()
  } catch {
    // ignore teardown races
  }
  wrapper?.remove()
  styleEl?.remove()
  player = null
  createPromise = null
  wrapper = null
  styleEl = null
  videoId = null
  instance = null
}
