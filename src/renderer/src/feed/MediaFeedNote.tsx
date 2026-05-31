import { ChevronRight, MessagesSquare, Play } from 'lucide-react'
import { formatClock } from '../lib/time'

/**
 * Presentational card for a YouTube video source note in the chronological feed.
 * Variant A "integrated bottom row" — the "open video notes" thread button is the
 * card's last row, divided by a hairline (Telegram-style affordance).
 *
 * Revision I-3: view-count / Eye element dropped — oEmbed does not expose views.
 * The only hardcoded color is `#1c1c1e` (dark thumbnail background), per spec.
 *
 * @see v21-design-system/v21-youtube-view-handoff/MediaFeedNote.jsx (variant A)
 * @see docs/specs/v0.2-youtube-annotation.md §Feed card
 */
export interface MediaFeedNoteProps {
  /** Video title from oEmbed; the caller passes the raw video id when null. */
  title: string | null
  channel: string | null
  /** Duration in seconds. Only shown when known (populated on first open). */
  durationSec: number | null
  /** Thumbnail URL. When null a dark 16:9 fallback is rendered — no broken <img>. */
  thumbnailUrl: string | null
  noteCount: number
  openQuestionCount: number
  /** Wall-clock epoch ms when this note entered the feed. */
  createdAt: number
  onOpenThread: () => void
}

/**
 * Telegram-style timestamp: same-day → time only, older → short date + time.
 * Why: MediaFeedNote lives in the same feed as NoteBubble; timestamps must follow
 * the same convention so the user's eye isn't confused by two formats in one scroll.
 * Why: duplicated from NoteBubble instead of extracted to lib/time — the wall-clock
 * format is presentational preference, not a domain invariant; extracting would
 * violate the inline-fix gate (exported symbol change, >4 impl files).
 */
function formatTimestamp(ms: number): string {
  const d = new Date(ms)
  const now = new Date()
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  return sameDay
    ? d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      })
}

export function MediaFeedNote({
  title,
  channel,
  durationSec,
  thumbnailUrl,
  noteCount,
  openQuestionCount,
  createdAt,
  onOpenThread,
}: MediaFeedNoteProps) {
  return (
    <div
      style={{
        maxWidth: 360,
        background: 'var(--bg-0)',
        border: '1px solid var(--border-0)',
        borderRadius: 'var(--r-4)',
        overflow: 'hidden',
        fontFamily: 'var(--font-sans)',
      }}
    >
      {/* 16:9 thumbnail region — dark fallback, optional image, play badge, duration chip */}
      <div
        style={{
          width: '100%',
          aspectRatio: '16 / 9',
          background: '#1c1c1e',
          position: 'relative',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          overflow: 'hidden',
        }}
      >
        {thumbnailUrl != null && (
          <img
            src={thumbnailUrl}
            alt=""
            style={{
              position: 'absolute',
              inset: 0,
              width: '100%',
              height: '100%',
              objectFit: 'cover',
            }}
          />
        )}
        {/* Play badge overlay */}
        <div
          style={{
            position: 'relative',
            width: 38,
            height: 38,
            borderRadius: '50%',
            background: 'rgba(255,255,255,0.16)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Play size={16} color="#fff" />
        </div>
        {/* Duration chip — only when durationSec is known */}
        {durationSec != null && (
          <span
            style={{
              position: 'absolute',
              right: 6,
              bottom: 6,
              fontFamily: 'var(--font-mono)',
              fontSize: 10,
              color: '#fff',
              background: 'rgba(0,0,0,0.72)',
              padding: '1px 5px',
              borderRadius: 3,
            }}
          >
            {formatClock(durationSec)}
          </span>
        )}
      </div>

      {/* Title + meta + bottom-right timestamp */}
      <div style={{ padding: '10px 12px' }}>
        <div
          style={{
            fontSize: 14,
            fontWeight: 500,
            color: 'var(--fg-0)',
            lineHeight: 'var(--lh-snug)',
          }}
        >
          {title}
        </div>
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-end',
            justifyContent: 'space-between',
            gap: 10,
            marginTop: 4,
          }}
        >
          {/* channel · duration meta line; duration part omitted when unknown */}
          <div
            style={{
              fontSize: 12,
              color: 'var(--fg-2)',
              fontFamily: 'var(--font-mono)',
            }}
          >
            {channel}
            {durationSec != null ? ` · ${formatClock(durationSec)}` : null}
          </div>
          {/* wall-clock bottom-right (Telegram-style) — no view count per I-3 */}
          <span
            style={{
              fontSize: 11,
              color: 'var(--fg-3)',
              whiteSpace: 'nowrap',
            }}
          >
            {formatTimestamp(createdAt)}
          </span>
        </div>
      </div>

      {/* Hairline-topped bottom row — "open video notes" thread button */}
      <button
        type="button"
        aria-label="open video notes"
        onClick={onOpenThread}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          width: '100%',
          cursor: 'pointer',
          border: 0,
          borderTop: '1px solid var(--border-0)',
          background: 'transparent',
          padding: '10px 12px',
          fontFamily: 'var(--font-sans)',
        }}
      >
        <MessagesSquare size={16} color="var(--accent)" />
        <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--accent)' }}>
          open video notes
        </span>
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 12, color: 'var(--fg-2)', whiteSpace: 'nowrap' }}>
          {noteCount} notes
          {openQuestionCount > 0 ? (
            <>
              {' · '}
              <span style={{ color: 'var(--type-question)' }}>{openQuestionCount} open</span>
            </>
          ) : null}
        </span>
        <ChevronRight size={15} color="var(--fg-3)" />
      </button>
    </div>
  )
}
