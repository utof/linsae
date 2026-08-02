import type { PlayerState } from '@shared/player'
import { LocateFixed, Maximize, Pause, Play } from 'lucide-react'
import { formatClock } from '../lib/time'

/**
 * Controlled presentational transport bar for the video thread player.
 * All playback state is owned by the caller — `PlayerPane` since v0.8.2, which wires it
 * to `usePlayer` and the shared `yt/transportState` store. (It was `ThreadView` until the
 * v0.6.4 B5 lift, after which this component was imported by nothing but its own test.)
 *
 * Why purely presentational: keeps this component decoupled from the player
 * singleton so it can be rendered/tested without a real YouTube iframe.
 *
 * Visual source: v21-design-system/v21-youtube-view-handoff/ThreadView.jsx
 * transport region (lines 190–205).
 *
 * @see docs/specs/v0.2-youtube-annotation.md §ThreadView / §TransportBar
 */
export interface TransportBarProps {
  /** Controls which icon is shown: 'playing' → Pause; anything else → Play. */
  state: PlayerState
  /** Current playhead position in seconds. */
  currentTime: number
  /** Total duration in seconds; null until the player reports it. */
  duration: number | null
  /** Current playback rate, e.g. 1, 1.5, 2. */
  rate: number
  /** Absolute positions (seconds) for marker ticks on the scrubber. */
  markers: number[]
  /** Whether the "follow playback" scroll lock is active. */
  followOn: boolean
  /** Toggle play / pause. */
  onPlayPause: () => void
  /**
   * Seek to the given position in seconds.
   * Why: scrubber click converts x-fraction → seconds and delegates here.
   */
  onSeek: (seconds: number) => void
  /** Cycle the playback rate. The sequence lives in `yt/transportState.ts` (`RATES`). */
  onRate: () => void
  /** Toggle follow-playback scroll lock. */
  onToggleFollow: () => void
  /** Enter fullscreen on the player. */
  onFullscreen: () => void
}

/**
 * Inline-style constants derived from v21 design tokens.
 * Why constants: avoids re-allocating objects on every render.
 */
const BAR: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '7px 12px',
  background: 'var(--bg-1)',
  border: '1px solid var(--border-0)',
  borderRadius: 'var(--r-2)',
  fontFamily: 'var(--font-sans)',
}

const ICON_BTN: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 24,
  height: 24,
  border: 0,
  background: 'transparent',
  cursor: 'pointer',
  borderRadius: 'var(--r-2)',
  color: 'var(--fg-1)',
  padding: 0,
}

const TIME_READOUT: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  color: 'var(--fg-2)',
  whiteSpace: 'nowrap',
}

const SPEED_BTN: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  color: 'var(--fg-1)',
  background: 'var(--bg-2)',
  borderRadius: 'var(--r-1)',
  padding: '1px 5px',
  border: 0,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
}

const SCRUBBER_TRACK: React.CSSProperties = {
  position: 'relative',
  flex: 1,
  height: 4,
  borderRadius: 2,
  background: 'var(--border-1)',
  cursor: 'pointer',
}

/** TransportBar: play/pause · time readout · scrubber with marker ticks · speed badge · follow toggle. */
export function TransportBar({
  state,
  currentTime,
  duration,
  rate,
  markers,
  followOn,
  onPlayPause,
  onSeek,
  onRate,
  onToggleFollow,
  onFullscreen,
}: TransportBarProps) {
  const safeD = duration !== null && duration > 0 ? duration : 0
  const fillPct = safeD > 0 ? (currentTime / safeD) * 100 : 0

  function handleTrackClick(e: React.MouseEvent<HTMLDivElement>) {
    if (duration === null || duration <= 0) return
    const rect = e.currentTarget.getBoundingClientRect()
    // rect.width is 0 in jsdom; fraction → 0 → seekTo(0) is fine for test.
    const fraction = rect.width > 0 ? (e.clientX - rect.left) / rect.width : 0
    onSeek(fraction * duration)
  }

  return (
    <div style={BAR}>
      {/* Play / Pause toggle */}
      <button
        type="button"
        aria-label={state === 'playing' ? 'pause' : 'play'}
        onClick={onPlayPause}
        style={ICON_BTN}
      >
        {state === 'playing' ? <Pause size={16} /> : <Play size={16} />}
      </button>

      {/* Time readout: currentTime / duration */}
      <span style={TIME_READOUT} data-testid="transport-time">
        {formatClock(currentTime)} / {formatClock(safeD)}
      </span>

      {/* Scrubber track with fill + marker ticks */}
      <div
        role="none"
        style={SCRUBBER_TRACK}
        data-testid="scrubber-track"
        onClick={handleTrackClick}
      >
        {/* filled portion */}
        <div
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            bottom: 0,
            width: `${fillPct}%`,
            background: 'var(--accent)',
            borderRadius: 2,
          }}
        />
        {/* marker ticks — clickable; only rendered when duration is known */}
        {safeD > 0 &&
          markers.map((t) => (
            <button
              // Why seconds-as-key: marker positions are the stable identity at this layer;
              // no note IDs available here. Duplicates are screened out upstream.
              key={t}
              type="button"
              aria-label={`seek to ${formatClock(t)}`}
              data-testid="scrubber-marker"
              // stopPropagation: a tick click must seek to its own t, not bubble to
              // the track's general click-seek (which would resolve a different x).
              onClick={(e) => {
                e.stopPropagation()
                onSeek(t)
              }}
              style={{
                // 12px-tall click target centered on the 4px track (top -4 →
                // button center at 2 = track center), wider than the tick for
                // an easy hit. The visible tick is the inner span.
                position: 'absolute',
                left: `${(t / safeD) * 100}%`,
                top: -4,
                width: 8,
                height: 12,
                padding: 0,
                border: 0,
                background: 'transparent',
                cursor: 'pointer',
                transform: 'translateX(-50%)',
              }}
            >
              <span
                style={{
                  // Thinner (1.5px) + longer (12px) tick, vertically centered on
                  // the track: the span fills the button height so it's centered
                  // around the track's mid-line, not sticking out the bottom.
                  display: 'block',
                  width: 1.5,
                  height: 12,
                  margin: '0 auto',
                  borderRadius: 1,
                  background: 'var(--fg-3)',
                }}
              />
            </button>
          ))}
      </div>

      {/* Playback speed badge */}
      <button type="button" aria-label="playback speed" onClick={onRate} style={SPEED_BTN}>
        {rate}×
      </button>

      {/* Fullscreen */}
      <button
        type="button"
        aria-label="fullscreen"
        title="fullscreen"
        onClick={onFullscreen}
        style={ICON_BTN}
      >
        <Maximize size={15} />
      </button>

      {/* Follow-playback toggle */}
      <button
        type="button"
        aria-label="follow playback"
        title="follow playback in notes"
        onClick={onToggleFollow}
        data-active={String(followOn)}
        style={{
          ...ICON_BTN,
          background: followOn ? 'var(--accent-tint)' : 'transparent',
          color: followOn ? 'var(--accent-press)' : 'var(--fg-3)',
        }}
      >
        <LocateFixed size={15} />
      </button>
    </div>
  )
}
