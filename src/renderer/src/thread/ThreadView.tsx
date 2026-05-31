import { useQuery } from '@tanstack/react-query'
import { ChevronLeft, Clock, Film } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { api } from '../lib/api'
import { usePlayer } from '../yt/usePlayer'
import { Rail } from './Rail'
import { markerPositions } from './rail-layout'
import { ThreadComposer } from './ThreadComposer'
import { TransportBar } from './TransportBar'
import { useThreadNotes } from './useThreadNotes'

/**
 * Centered content column width — matches ThreadView.jsx in the design-system
 * handoff (v21-design-system/v21-youtube-view-handoff/ThreadView.jsx line 51).
 *
 * Why: shared column for player, sort pill, notes, and composer so rail gutters
 * align correctly when the Rail lands in D4.
 */
const COL = 520

/**
 * ThreadView — shell for a single video-annotation thread.
 *
 * Regions (top → bottom):
 *   1. Slim top bar: back button + video title.
 *   2. Pinned 16:9 player region (singleton iframe re-parents into hostRef).
 *   3. Scrollable content column: SortPill + minimal note list (Rail in D4).
 *   4. Pinned composer slot (ThreadComposer in E3).
 *
 * Behavior notes:
 * - Duration write-back (I-4): when `duration` first becomes non-null on this
 *   mount, `api.videoSources.upsert` is called once with `{ durationSec }` so
 *   the value is cached for offline use. A ref flag prevents repeat calls even
 *   if the effect fires more than once (StrictMode double-invoke).
 * - `followOn` defaults to true per spec §TransportBar.
 * - Sort defaults to 'video' (video-time order); pill toggles to 'capture'.
 *
 * Visual source: v21-design-system/v21-youtube-view-handoff/ThreadView.jsx
 * (shell region lines 276–334).
 *
 * @see src/renderer/src/thread/useThreadNotes.ts
 * @see src/renderer/src/thread/TransportBar.tsx
 * @see src/renderer/src/thread/rail-layout.ts
 * @see docs/specs/v0.2-youtube-annotation.md §ThreadView
 */
export interface ThreadViewProps {
  /** UUID of the source-type note representing the video. */
  noteId: string
  /** Called when the user presses the back button. */
  onClose: () => void
}

/** @see ThreadViewProps */
export function ThreadView({ noteId, onClose }: ThreadViewProps) {
  // ── data fetches ──────────────────────────────────────────────────────────

  const { data: note } = useQuery({
    queryKey: ['note', noteId],
    queryFn: () => api.notes.get(noteId),
    enabled: !!noteId,
  })

  const videoId = note?.source_locator?.video_id ?? ''

  const { data: videoSource } = useQuery({
    queryKey: ['videoSource', videoId],
    queryFn: () => api.videoSources.get(videoId),
    enabled: !!videoId,
  })

  const title = videoSource?.title ?? videoId

  // ── player ────────────────────────────────────────────────────────────────

  const hostRef = useRef<HTMLDivElement>(null)
  const { player, currentTime, state, duration } = usePlayer(videoId, hostRef)

  // ── duration write-back (I-4) ─────────────────────────────────────────────
  // Write the resolved duration back to video_sources exactly once per mount.
  // A ref flag prevents repeat writes under React StrictMode double-invoke.
  // Why: getDuration() is 0 until the video is cued, so we write only after
  // usePlayer's re-poll yields a non-null value.
  //
  // @see src/renderer/src/yt/usePlayer.ts (I-4 comment in the rAF loop)
  const durationWrittenRef = useRef(false)
  useEffect(() => {
    if (!videoId || duration == null || durationWrittenRef.current) return
    durationWrittenRef.current = true
    void api.videoSources.upsert(videoId, { durationSec: duration })
  }, [videoId, duration])

  // ── sort + thread notes ───────────────────────────────────────────────────

  const [sortMode, setSortMode] = useState<'video' | 'capture'>('video')
  const { sorted, clusters, anchorless } = useThreadNotes(noteId, sortMode)

  // ── follow state ──────────────────────────────────────────────────────────

  const [followOn, setFollowOn] = useState(true)

  // ── derived transport values ──────────────────────────────────────────────

  const markers = markerPositions(sorted, duration).map((m) => m.t)

  // ── render ────────────────────────────────────────────────────────────────

  return (
    <div
      style={{
        height: '100%',
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        position: 'relative',
        background: 'var(--bg-0)',
      }}
    >
      {/* ── 1. Slim top bar ─────────────────────────────────────────────── */}
      <header
        style={{
          flex: '0 0 auto',
          height: 46,
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '0 16px',
          borderBottom: '1px solid var(--border-0)',
        }}
      >
        <button
          type="button"
          aria-label="back"
          onClick={onClose}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 28,
            height: 28,
            border: 0,
            background: 'transparent',
            cursor: 'pointer',
            borderRadius: 'var(--r-2)',
            color: 'var(--fg-2)',
            padding: 0,
            flexShrink: 0,
          }}
        >
          <ChevronLeft size={17} />
        </button>
        <div style={{ minWidth: 0 }}>
          <div
            style={{
              fontSize: 13,
              fontWeight: 500,
              color: 'var(--fg-0)',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {title}
          </div>
        </div>
      </header>

      {/* ── 2. Pinned player region ─────────────────────────────────────── */}
      <div
        style={{
          flex: '0 0 auto',
          padding: '14px 24px 12px',
          borderBottom: '1px solid var(--border-0)',
        }}
      >
        <div style={{ maxWidth: COL, margin: '0 auto' }}>
          {/* 16:9 container — the singleton's iframe re-parents into hostRef */}
          <div
            style={{
              width: '100%',
              aspectRatio: '16 / 9',
              background: '#1c1c1e',
              borderRadius: 'var(--r-4) var(--r-4) 0 0',
              overflow: 'hidden',
            }}
          >
            <div
              ref={hostRef}
              data-testid="player-host"
              style={{ width: '100%', height: '100%' }}
            />
          </div>
          <TransportBar
            state={state}
            currentTime={currentTime}
            duration={duration}
            rate={1}
            markers={markers}
            followOn={followOn}
            onPlayPause={() => {
              if (state === 'playing') {
                player.pause()
              } else {
                player.play()
              }
            }}
            onSeek={(s) => {
              void player.seekTo(s)
            }}
            onRate={() => {
              // Rate cycling deferred to F1; no-op shell here.
            }}
            onToggleFollow={() => {
              setFollowOn((v) => !v)
            }}
          />
        </div>
      </div>

      {/* ── 3. Scrollable content column ────────────────────────────────── */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          padding: '16px 24px 10px',
          position: 'relative',
        }}
      >
        <div style={{ maxWidth: COL, margin: '0 auto' }}>
          {/* SortPill: toggles between video-time and capture-time order */}
          <SortPill
            sortMode={sortMode}
            onToggle={() => setSortMode((m) => (m === 'video' ? 'capture' : 'video'))}
          />

          {/* The thread rendering: video-order rail (default) or capture feed. */}
          <Rail
            clusters={clusters}
            anchorless={anchorless}
            sorted={sorted}
            mode={sortMode}
            playheadT={currentTime}
            onSeekNote={(t) => {
              void player.seekTo(t)
            }}
          />
        </div>
      </div>

      {/* ── 4. Pinned composer slot ─────────────────────────────────────── */}
      <div
        style={{
          flex: '0 0 auto',
          borderTop: '1px solid var(--border-0)',
          padding: '10px 24px 12px',
          background: 'var(--bg-0)',
        }}
      >
        <div style={{ maxWidth: COL, margin: '0 auto' }}>
          <ThreadComposer
            livePlayhead={currentTime}
            onPost={({ body, t }) => {
              // E4 wires the real api.notes.create + commentOn here.
              // For now this is a no-op shell so ThreadView compiles.
              void body
              void t
            }}
            onManualSeekEntry={(s) => {
              void player.seekTo(s)
            }}
          />
        </div>
      </div>
    </div>
  )
}

// ── SortPill ─────────────────────────────────────────────────────────────────

interface SortPillProps {
  sortMode: 'video' | 'capture'
  onToggle: () => void
}

/**
 * Toggles between video-time and capture-time sort modes.
 * Film glyph = video order; Clock glyph = capture order.
 *
 * Visual source: v21-design-system/v21-youtube-view-handoff/ThreadView.jsx
 * SortPill component (lines 209–219).
 *
 * @see ThreadView
 */
function SortPill({ sortMode, onToggle }: SortPillProps) {
  return (
    <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 14 }}>
      <button
        type="button"
        aria-label="sort mode"
        title={`sorted by ${sortMode === 'video' ? 'position in the video' : 'when captured'} — click to switch`}
        onClick={onToggle}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 7,
          height: 27,
          padding: '0 10px',
          border: '1px solid var(--border-0)',
          borderRadius: 'var(--r-pill)',
          background: 'var(--bg-1)',
          color: 'var(--fg-1)',
          fontSize: 12,
          cursor: 'pointer',
        }}
      >
        {sortMode === 'video' ? (
          <Film size={13} color="var(--fg-2)" />
        ) : (
          <Clock size={13} color="var(--fg-2)" />
        )}
        {sortMode === 'video' ? 'by video time' : 'by capture time'}
      </button>
    </div>
  )
}
