import { useRef } from 'react'
import { useSetting } from '../lib/use-setting'
import { usePlayer } from './usePlayer'

/**
 * Right-dock content pane hosting the singleton YouTube webview placeholder.
 *
 * Reads the current `videoId` from `'player.videoId'` app-setting (written by
 * `ThreadView` when a YouTube thread opens — mirrors how `PdfReader` reads
 * `'pdf.openDocId'` set by the PDF import/open flow).
 *
 * WHY here and not inside ThreadView: the webview is `position:fixed` and MUST
 * NOT be re-parented (moving a `<webview>` destroys its guest WebContents —
 * electron#9529). Docking the placeholder here means the player persists while
 * the center stage flips feed↔canvas (B5). Exactly one `usePlayer` mount is live
 * at any time — the SINGLE-MOUNT INVARIANT (ADR 0016).
 *
 * Param mechanism: `useSetting('player.videoId', null)` → `useQuery` over the
 * SQLite `app_settings` table. `ThreadView` writes the setting via
 * `useSetSetting('player.videoId')` before calling `openPane('player')`.
 *
 * @see src/renderer/src/yt/usePlayer.ts
 * @see src/renderer/src/yt/playerSingleton.ts (why fixed overlay, ADR 0012/0016)
 * @see src/renderer/src/thread/ThreadView.tsx (writes the setting + opens the pane)
 * @see src/renderer/src/pdf/PdfReader.tsx (reference: same param pattern via usePdfOpenId)
 */
export function PlayerPane(): React.JSX.Element {
  const videoId = useSetting<string | null>('player.videoId', null)

  // Guard: do not render the inner component (which calls usePlayer) until
  // videoId is non-null. Calling usePlayer('', hostRef) would navigate the
  // singleton to youtube.com/watch?v= which destroys the guest session.
  // Sub-component is the idiomatic split for conditional hooks (rules of hooks).
  if (!videoId) {
    return (
      <div
        data-testid="player-pane"
        style={{ width: '100%', height: '100%', background: '#000' }}
      />
    )
  }

  return <PlayerPaneInner videoId={videoId} />
}

/**
 * Inner shell: mounts only when `videoId` is non-null. Owns the SOLE live
 * `usePlayer` call — the single-mount invariant holder after B5. When this
 * component unmounts (pane closed), `usePlayer`'s cleanup calls
 * `player.unmount()`, parking the webview off-screen (guest stays alive).
 *
 * Why: React rules of hooks forbid conditional `useEffect` inside one component;
 * a sub-component is the safe split. The guard lives in the parent `PlayerPane`.
 */
function PlayerPaneInner({ videoId }: { videoId: string }): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  usePlayer(videoId, hostRef)

  return (
    <div data-testid="player-pane" style={{ width: '100%', height: '100%', background: '#000' }}>
      {/*
       * Placeholder div: the fixed-position webview tracks this element's
       * bounding rect each frame via the syncBounds rAF loop (playerSingleton.ts).
       * The webview is never re-parented; only its `left`/`top`/`width`/`height`
       * are updated. Do NOT add display:none or visibility:hidden here — both
       * can destroy the guest WebContents (electron#7700).
       */}
      <div ref={hostRef} data-testid="player-host" style={{ width: '100%', height: '100%' }} />
    </div>
  )
}
