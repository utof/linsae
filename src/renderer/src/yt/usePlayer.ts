import { useEffect, useRef, useState } from 'react'
import type { PlayerState } from '../../../shared/player'
import { getPlayer } from './playerSingleton'

/**
 * Mounts the singleton into `hostRef`, loads `videoId`, exposes a coarse
 * playhead tick (~5 Hz via rAF) and a lazy duration that re-polls until
 * non-null (getDuration() returns 0/null until the video is cued — a one-shot
 * would leave duration null forever, breaking scrubber markers).
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
    let durationDone = false
    const tick = (ts: number) => {
      if (ts - last > 200) {
        last = ts
        player.getCurrentTime().then(setCurrentTime)
        // I-4: getDuration() is 0 until the video is cued — re-poll until non-null, then stop.
        if (!durationDone) {
          player.getDuration().then((d) => {
            if (d != null) {
              durationDone = true
              setDuration(d)
            }
          })
        }
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
