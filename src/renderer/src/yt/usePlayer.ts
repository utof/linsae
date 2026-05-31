import { useEffect, useRef, useState } from 'react'
import type { PlayerState } from '../../../shared/player'
import { getPlayer } from './playerSingleton'

/**
 * Mounts the singleton into `hostRef`, loads `videoId`, exposes a coarse
 * playhead tick (~5 Hz via rAF) and a lazy duration that re-polls until
 * non-null (getDuration() returns 0/null until the video is cued — a one-shot
 * would leave duration null forever, breaking scrubber markers).
 *
 * Why: singleton pattern documented in playerSingleton.ts + ADR 0008.
 * Cleanup cancels the rAF and unsubscribes state listener but does NOT destroy
 * the singleton — it persists across React mounts so the iframe never reloads.
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
    hostRef.current?.appendChild(player.wrapper)
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
    } // singleton persists; only this view's listeners stop
  }, [videoId, hostRef])

  return { player: playerRef.current, currentTime, state, duration }
}
