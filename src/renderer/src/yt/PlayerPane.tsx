import { useEffect, useRef } from 'react'
import { useSetting } from '../lib/use-setting'
import { TransportBar } from '../thread/TransportBar'
import { useTransportStore } from './transportState'
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
 * Also hosts the `TransportBar` (B2): YouTube's native controls are suppressed in the
 * guest (`inject/youtube-guest.ts:121`, `v.controls = false`), so between the v0.6.4 B5
 * lift and here the docked player had NO scrubber, speed badge, follow-toggle or
 * fullscreen — only whatever the bare webview happened to accept. (#169)
 *
 * @see src/renderer/src/yt/usePlayer.ts
 * @see src/renderer/src/yt/playerSingleton.ts (why fixed overlay, ADR 0012/0016)
 * @see src/renderer/src/yt/transportState.ts (the cross-pane store the bar reads/writes)
 * @see src/renderer/src/thread/TransportBar.tsx (presentational; owns no state)
 * @see src/renderer/src/thread/ThreadView.tsx (writes the setting + opens the pane)
 * @see src/renderer/src/pdf/PdfReader.tsx (reference: same param pattern via usePdfOpenId)
 * @issue utof/linsae#169
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
 * Pane layout. A flex COLUMN so the transport bar can sit under the host without
 * overlapping it. Shrinking the host is safe — the fixed webview re-reads the host's
 * rect every frame in the `syncBounds` rAF loop (playerSingleton.ts:150-167).
 */
const PANE: React.CSSProperties = {
  width: '100%',
  height: '100%',
  background: '#000',
  display: 'flex',
  flexDirection: 'column',
}

/** `minHeight: 0` so the host can actually shrink inside the flex column. */
const HOST: React.CSSProperties = { flex: 1, minHeight: 0, width: '100%' }

/** `flex: '0 0 auto'` — the bar keeps its intrinsic height; the host takes the rest. */
const BAR_SLOT: React.CSSProperties = { flex: '0 0 auto', padding: 8 }

/**
 * Inner shell: mounts only when `videoId` is non-null. Owns the SOLE live
 * `usePlayer` call — the single-mount invariant holder after B5. When this
 * component unmounts (pane closed), `usePlayer`'s cleanup calls
 * `player.unmount()`, parking the webview off-screen (guest stays alive).
 *
 * Why: React rules of hooks forbid conditional `useEffect` inside one component;
 * a sub-component is the safe split. The guard lives in the parent `PlayerPane`.
 *
 * The transport is driven by `usePlayer`'s OWN return value — deliberately NOT a
 * second `usePlayerState(videoId)`. Both hooks return the identical
 * `{ player, currentTime, state, duration }` shape (usePlayer.ts:57 /
 * usePlayerState.ts:58); this component already runs `usePlayer` and was simply
 * discarding it, so adding `usePlayerState` here would only duplicate the ~5 Hz rAF
 * poll and the `onStateChange` subscription. `player` is the full singleton handle
 * (`playerRef = useRef(getPlayer())`), which is what the five callbacks need.
 */
function PlayerPaneInner({ videoId }: { videoId: string }): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const { player, currentTime, state, duration } = usePlayer(videoId, hostRef)

  // Cross-pane transport state. `markers` are published by ThreadView (the center
  // stage), which is this pane's SIBLING — pane-local state could not reach it.
  const followOn = useTransportStore((s) => s.followOn)
  const rate = useTransportStore((s) => s.rate)
  const markers = useTransportStore((s) => s.markers)
  const toggleFollow = useTransportStore((s) => s.toggleFollow)
  const cycleRate = useTransportStore((s) => s.cycleRate)

  // Re-push the rate at the guest. REQUIRED, not belt-and-braces: `load(id)`
  // reassigns `webviewEl.src` (playerSingleton.ts:299-307) — a full guest reload that
  // destroys the `<video>` the guest's `setRate` handler wrote to
  // (inject/youtube-guest.ts:203) — and `Player` has no `getPlaybackRate()` to read the
  // truth back, so this store is the ONLY holder. Without the re-push the badge would
  // read 1.75× while playback ran at 1×.
  //
  // `state` is in the deps on purpose: `setPlaybackRate` is `rpc?.invoke('setRate', r)`
  // (playerSingleton.ts:337-339) and `load()` NULLS `rpc` (:303) until the reloaded
  // guest's dom-ready re-creates it — so the push fired at videoId-change time is
  // swallowed. A state event is the only public signal that the new guest's port is
  // live. Pushing again on later state changes is idempotent and cheap.
  //
  // Do NOT delete this in favour of `onRate` below: `onRate` covers only the click.
  // biome-ignore lint/correctness/useExhaustiveDependencies: videoId + state are re-run TRIGGERS, not values the body reads — the guest they push to was replaced. Same pattern as usePlayerState.ts:26.
  useEffect(() => {
    void player.setPlaybackRate(rate)
  }, [player, rate, videoId, state])

  return (
    <div data-testid="player-pane" style={PANE}>
      {/*
       * Placeholder div: the fixed-position webview tracks this element's
       * bounding rect each frame via the syncBounds rAF loop (playerSingleton.ts).
       * The webview is never re-parented; only its `left`/`top`/`width`/`height`
       * are updated. Do NOT add display:none or visibility:hidden here — both
       * can destroy the guest WebContents (electron#7700).
       */}
      <div ref={hostRef} data-testid="player-host" style={HOST} />
      <div style={BAR_SLOT}>
        <TransportBar
          state={state}
          currentTime={currentTime}
          duration={duration}
          rate={rate}
          markers={markers}
          followOn={followOn}
          onPlayPause={() => {
            if (state === 'playing') {
              void player.pause()
            } else {
              // play() goes straight to the guest WITH a user gesture — routing it
              // over RPC loses the transient activation (playerSingleton.ts:309-319).
              void player.play()
            }
          }}
          onSeek={(s) => {
            void player.seekTo(s)
          }}
          // `cycleRate()` advances the store AND returns the new rate, so the sequence
          // stays module-local to transportState.ts (`RATES` is not exported).
          onRate={() => {
            void player.setPlaybackRate(cycleRate())
          }}
          onToggleFollow={toggleFollow}
          onFullscreen={() => {
            // Drives YouTube's OWN fullscreen button inside the guest — fullscreening
            // the host wrapper leaves the video trapped in its stacking context.
            player.toggleFullscreen()
          }}
        />
      </div>
    </div>
  )
}
