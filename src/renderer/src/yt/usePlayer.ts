import { useEffect, useRef, useState } from 'react'
import type { PlayerState } from '../../../shared/player'
import { getPlayer } from './playerSingleton'

/**
 * Mounts the singleton into `hostRef`, loads `videoId`, and exposes a coarse
 * playhead tick (~5 Hz via rAF) plus a duration re-read on every one of those
 * ticks (getDuration() returns 0/null until the video is cued, and the
 * singleton drops the cached value on every guest reset — a one-shot, or a
 * latch on the first non-null read, would leave the scrubber scaled to null or
 * to the outgoing video for the life of the mount; #211 L2, spec §7 L2).
 *
 * Why: singleton pattern documented in playerSingleton.ts + ADR 0008/0016.
 * The webview is NEVER re-parented (moving a <webview> destroys its guest —
 * electron#9529); usePlayer only mount()s it (show + position-sync over hostRef)
 * and unmount()s it (hide) on cleanup. The singleton persists, so the guest is
 * never torn down and the page never reloads on StrictMode double-mount.
 *
 * @see src/renderer/src/yt/playerSingleton.ts
 */
export function usePlayer(videoId: string, hostRef: React.RefObject<HTMLElement | null>) {
  const [currentTime, setCurrentTime] = useState(0)
  const [state, setState] = useState<PlayerState>('unstarted')
  const [duration, setDuration] = useState<number | null>(null)
  const playerRef = useRef(getPlayer())

  useEffect(() => {
    const player = playerRef.current
    if (hostRef.current) player.mount(hostRef.current)
    player.load(videoId)
    const unsub = player.onStateChange(setState)
    let raf = 0
    let last = 0
    const tick = (ts: number) => {
      if (ts - last > 200) {
        last = ts
        player.getCurrentTime().then(setCurrentTime)
        // I-4: getDuration() is null until the video is cued, so keep polling. NOT latched on
        // the first non-null read: the singleton resets its cache on every guest reset (#211
        // L1), and a latch would pin this hook to whatever spoke first — the outgoing video's
        // duration, or a pre-roll ad's — for the whole life of the mount. Re-polling costs
        // nothing: `setDuration(d)` with an unchanged `d` is a React bail-out (`Object.is`).
        // Spec §7 L2.
        player.getDuration().then((d) => {
          if (d != null) setDuration(d)
        })
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(raf)
      unsub()
      player.unmount() // park the (persistent) webview off-screen; guest is NOT destroyed
    }
  }, [videoId, hostRef])

  return { player: playerRef.current, currentTime, state, duration }
}
