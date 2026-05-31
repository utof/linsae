/**
 * Module-level YouTube player singleton. The IFrame API REPLACES its target
 * element, so we hold a STABLE wrapper <div> at module scope and create a
 * disposable inner child as the YT target — the wrapper (and the iframe inside
 * it) survives React 19 StrictMode's double-mount because it lives outside the
 * React tree (the `instance` guard returns the existing player). usePlayer
 * re-parents the wrapper into the ThreadView DOM on mount.
 *
 * @see docs/specs/v0.2-youtube-annotation.md §Player subsystem (singleton, ADR 0008)
 */
import YouTubePlayer from 'youtube-player'

import type { Player, PlayerState } from '../../../shared/player'

let wrapper: HTMLDivElement | null = null
let raw: ReturnType<typeof YouTubePlayer> | null = null
let instance:
  | (Player & {
      wrapper: HTMLDivElement
      getIframeRect(): DOMRect | null
      videoId: string | null
    })
  | null = null

const STATE: Record<number, PlayerState> = {
  '-1': 'unstarted',
  0: 'ended',
  1: 'playing',
  2: 'paused',
  3: 'buffering',
  5: 'cued',
}

/** Returns the singleton, constructing the detached wrapper + player on first call. */
export function getPlayer() {
  if (instance) return instance
  wrapper = document.createElement('div')
  wrapper.id = 'yt-player-wrapper'
  wrapper.style.width = '100%'
  wrapper.style.height = '100%'
  const target = document.createElement('div') // youtube-player replaces THIS with the iframe
  wrapper.appendChild(target)
  // `host` is included in @types/youtube-player Options; `playerVars.enablejsapi` is typed as 0|1.
  raw = YouTubePlayer(target, {
    host: 'https://www.youtube-nocookie.com',
    playerVars: { enablejsapi: 1, controls: 0, rel: 0, playsinline: 1 },
  })
  raw
    .getIframe()
    .then((f: HTMLIFrameElement) =>
      f?.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin'),
    )
  let videoId: string | null = null
  instance = {
    wrapper,
    get videoId() {
      return videoId
    },
    async load(id) {
      videoId = id
      await raw!.loadVideoById(id)
    },
    play: () => raw!.playVideo(),
    pause: () => raw!.pauseVideo(),
    seekTo: (s) => raw!.seekTo(s, true),
    getCurrentTime: () => raw!.getCurrentTime(),
    async getDuration() {
      const d = await raw!.getDuration()
      return d > 0 ? d : null
    },
    setPlaybackRate: (r) => raw!.setPlaybackRate(r),
    onStateChange(cb) {
      // sister.on returns a listener token; sister.off takes that same token.
      // @types/youtube-player types `on` as returning void, but at runtime it returns
      // the sister listener object — cast to unknown to thread through the token.
      // Why: sister@3.x API — see node_modules/.pnpm/sister@3.0.2/.../sister.js
      const listener = (
        raw!.on as (event: 'stateChange', handler: (e: { data: number }) => void) => unknown
      )('stateChange', (e: { data: number }) => cb(STATE[e.data] ?? 'unstarted'))
      return () => (raw as unknown as { off(l: unknown): void })!.off(listener)
    },
    getIframeRect() {
      const f = wrapper!.querySelector('iframe')
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
  raw?.destroy()
  wrapper?.remove()
  raw = null
  wrapper = null
  instance = null
}
