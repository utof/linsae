import { ArrowDown, ArrowUp } from 'lucide-react'
import { formatClock } from '../lib/time'

/**
 * Floating "jump to now" pill shown over the notes column when the playhead has
 * scrolled out of view (follow off, video mode — see {@link jumpPillVisible}).
 *
 * Presentational only: ThreadView decides visibility and supplies `onJump`,
 * which smooth-scrolls the active cluster back into view.
 *
 * @see src/renderer/src/thread/rail-layout.ts (jumpPillVisible)
 * @see docs/specs/v0.2-youtube-annotation.md §ThreadView
 */
export interface JumpPillProps {
  /** Current playback position in seconds, shown as a clock. */
  seconds: number
  /** Invoked when the pill is clicked — scrolls the playhead cluster into view. */
  onJump: () => void
  /**
   * Which way "now" is from the current scroll position: `'up'` when the
   * playhead is above the viewport (arrow points up), `'down'` when below.
   * Defaults to `'down'` for back-compat.
   */
  direction?: 'up' | 'down'
}

/** @see JumpPillProps */
export function JumpPill({ seconds, onJump, direction = 'down' }: JumpPillProps) {
  return (
    <button
      type="button"
      aria-label="jump to now"
      onClick={onJump}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        height: 30,
        padding: '0 12px',
        border: 0,
        borderRadius: 'var(--r-pill)',
        background: 'var(--accent)',
        // White text on the accent blue — matches the v21 accent-on-fill treatment;
        // there is no token for accent foreground (#fff is a blessed literal here).
        color: '#fff',
        fontFamily: 'var(--font-sans)',
        fontSize: 12,
        fontWeight: 500,
        cursor: 'pointer',
        boxShadow: 'var(--shadow-2)',
      }}
    >
      {direction === 'up' ? <ArrowUp size={14} /> : <ArrowDown size={14} />}
      jump to now
      <span style={{ fontFamily: 'var(--font-mono)', opacity: 0.85 }}>{formatClock(seconds)}</span>
    </button>
  )
}
