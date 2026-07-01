import { useEffect, useRef, useState } from 'react'
import type { PlayerState } from '../../../shared/player'
import { getPlayer } from './playerSingleton'

/**
 * Read-only playback state hook — subscribes to the singleton's state changes
 * and polls `currentTime`/`duration` at ~5 Hz, but does NOT call
 * `player.mount()`, `player.unmount()`, or `player.load()`.
 *
 * Why split from `usePlayer`: after B5 (`PlayerPane`), `ThreadView` still needs
 * `currentTime`/`duration` for the Rail, follow-scroll, duration write-back, and
 * `ThreadComposer` — but must not own the mount point. The SINGLE-MOUNT INVARIANT
 * requires exactly one live `player.mount()` call; that is `PlayerPane`'s `usePlayer`.
 * Any number of `usePlayerState` calls can co-exist without disturbing the mount.
 *
 * @see src/renderer/src/yt/usePlayer.ts (full mount+load hook for PlayerPane)
 * @see src/renderer/src/yt/PlayerPane.tsx
 * @see src/renderer/src/thread/ThreadView.tsx
 */
export function usePlayerState(videoId: string) {
  const [currentTime, setCurrentTime] = useState(0)
  const [state, setState] = useState<PlayerState>('unstarted')
  const [duration, setDuration] = useState<number | null>(null)
  const playerRef = useRef(getPlayer())

  // biome-ignore lint/correctness/useExhaustiveDependencies: videoId not referenced in body; dep ensures durationDone resets on video change (same pattern as usePlayer.ts [videoId, hostRef])
  useEffect(() => {
    const player = playerRef.current
    const unsub = player.onStateChange(setState)
    let raf = 0
    let last = 0
    let durationDone = false
    const tick = (ts: number) => {
      if (ts - last > 200) {
        last = ts
        player.getCurrentTime().then(setCurrentTime)
        // Re-poll duration until non-null (getDuration returns null until the
        // video is cued — a one-shot would leave duration null forever, breaking
        // the scrubber markers). Same I-4 pattern as usePlayer.ts.
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
    }
  }, [videoId])

  return { player: playerRef.current, currentTime, state, duration }
}
