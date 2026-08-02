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

  // `videoId` is not read in the body — it is a re-run TRIGGER, and it is kept deliberately:
  // re-running restarts the poll loop with `last = 0`, so the incoming video's first
  // `currentTime`/`duration` read lands on the next frame instead of up to 200ms into the
  // outgoing loop's throttle window. Its FORMER justification — resetting a `durationDone`
  // latch — died with the latch (#211 L2, spec §7 L2); the latch lived inside this closure, so
  // this dep was the only thing that ever reset it, which is why the two facts were entangled.
  // biome-ignore lint/correctness/useExhaustiveDependencies: videoId is a re-run trigger, not a value the body reads — see the note above.
  useEffect(() => {
    const player = playerRef.current
    const unsub = player.onStateChange(setState)
    let raf = 0
    let last = 0
    const tick = (ts: number) => {
      if (ts - last > 200) {
        last = ts
        player.getCurrentTime().then(setCurrentTime)
        // Re-poll duration until non-null (getDuration returns null until the video is cued —
        // a one-shot would leave duration null forever, breaking the scrubber markers), and
        // keep polling AFTER that: the singleton resets its cache on every guest reset (#211
        // L1), so a latch here pins the hook to the outgoing video's duration and `ThreadView`
        // writes it to the incoming video's row. Same I-4 pattern as `usePlayer`.
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
    }
  }, [videoId])

  return { player: playerRef.current, currentTime, state, duration }
}
