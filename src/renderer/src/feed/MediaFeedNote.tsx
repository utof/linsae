import { useQuery } from '@tanstack/react-query'
import { ChevronRight, Link2, MessagesSquare, Trash2 } from 'lucide-react'
import { type MouseEvent, useEffect, useRef, useState } from 'react'
import type { Note } from '../../../shared/types'
import { api } from '../lib/api'
import { useClock24 } from '../lib/clock-pref'
import { formatClock } from '../lib/time'
import { useThreadNotes } from '../thread/useThreadNotes'

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
  /**
   * Hover-toolbar actions (parity with NoteBubble's edit/copy/delete bar). When
   * omitted the toolbar is hidden. `edit` is intentionally absent — a source note
   * has no editable body; you annotate inside the thread, not on the card.
   */
  onDelete?: () => void
  onCopyLink?: () => void
}

/**
 * Telegram-style timestamp: same-day → time only, older → short date + time.
 * Why: MediaFeedNote lives in the same feed as NoteBubble; timestamps must follow
 * the same convention so the user's eye isn't confused by two formats in one scroll.
 * Why: duplicated from NoteBubble instead of extracted to lib/time — the wall-clock
 * format is presentational preference, not a domain invariant; extracting would
 * violate the inline-fix gate (exported symbol change, >4 impl files).
 */
function formatTimestamp(ms: number, hour12: boolean): string {
  const d = new Date(ms)
  const now = new Date()
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  return sameDay
    ? d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', hour12 })
    : d.toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        hour12,
      })
}

/**
 * Data container for a video source note in the feed.
 * Fetches title/channel/thumbnail/duration from the videoSources cache and
 * derives noteCount/openQuestionCount from the thread comment list, then
 * renders a `MediaFeedNote` card.
 *
 * Why a separate container (not inline in NoteBubble): the query + hook coupling
 * lives here so NoteBubble stays a thin dispatcher that delegates based on
 * `source_kind`; the container owns its own loading boundary.
 *
 * @see src/renderer/src/feed/NoteBubble.tsx (isSource branch)
 * @see docs/specs/v0.2-youtube-annotation.md §Feed card
 */
export function MediaFeedNoteContainer({
  note,
  onOpenThread,
  onDelete,
  onCopyLink,
}: {
  note: Note
  onOpenThread?: (id: string) => void
  onDelete?: () => void
  onCopyLink?: () => void
}) {
  const videoId = note.source_locator?.video_id ?? ''
  const { data: meta } = useQuery({
    queryKey: ['videoSource', videoId],
    queryFn: () => api.videoSources.get(videoId),
    enabled: !!videoId,
  })
  const { noteCount, openQuestionCount } = useThreadNotes(note.id, 'video')
  return (
    <MediaFeedNote
      title={meta?.title ?? videoId}
      channel={meta?.channel ?? null}
      durationSec={meta?.durationSec ?? null}
      thumbnailUrl={meta?.thumbnailUrl ?? null}
      noteCount={noteCount}
      openQuestionCount={openQuestionCount}
      createdAt={note.created_at}
      onOpenThread={() => onOpenThread?.(note.id)}
      {...(onDelete ? { onDelete } : {})}
      {...(onCopyLink ? { onCopyLink } : {})}
    />
  )
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
  onDelete,
  onCopyLink,
}: MediaFeedNoteProps) {
  const clock24 = useClock24()
  const [hover, setHover] = useState(false)
  // Two-click delete arm, mirroring NoteBubble: deleting a video card removes the
  // whole source note, so a single misclick over the thumbnail shouldn't nuke it.
  const [deleteArmed, setDeleteArmed] = useState(false)
  const armTimer = useRef<number | null>(null)
  // Clear a pending arm timer on unmount so it can't setState a virtualised-out card.
  useEffect(
    () => () => {
      if (armTimer.current !== null) clearTimeout(armTimer.current)
    },
    [],
  )
  const showToolbar = hover && (onDelete != null || onCopyLink != null)
  const handleTrashClick = (e: MouseEvent) => {
    e.stopPropagation()
    if (deleteArmed) {
      if (armTimer.current !== null) clearTimeout(armTimer.current)
      setDeleteArmed(false)
      onDelete?.()
      return
    }
    setDeleteArmed(true)
    armTimer.current = window.setTimeout(() => setDeleteArmed(false), 2000)
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the card root only tracks hover to reveal the action toolbar; the actionable targets are the inner <button>s (thumbnail / open-notes / copy / delete).
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => {
        setHover(false)
        setDeleteArmed(false)
      }}
      style={{
        position: 'relative',
        maxWidth: 360,
        background: 'var(--bg-0)',
        border: '1px solid var(--border-0)',
        borderRadius: 'var(--r-4)',
        overflow: 'hidden',
        fontFamily: 'var(--font-sans)',
      }}
    >
      {/* 16:9 thumbnail — click anywhere to open the thread; dark fallback, optional
          image, duration chip. The play-badge overlay was removed (no inline playback
          here — the thumbnail is a thread affordance, not a player). */}
      <button
        type="button"
        aria-label={title ? `open notes for ${title}` : 'open video notes'}
        onClick={onOpenThread}
        style={{
          display: 'block',
          width: '100%',
          aspectRatio: '16 / 9',
          background: '#1c1c1e',
          position: 'relative',
          border: 0,
          padding: 0,
          cursor: 'pointer',
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
      </button>

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
          {/* channel meta line — duration lives only on the thumbnail chip now
              (it used to be duplicated here next to the channel). */}
          <div
            style={{
              fontSize: 12,
              color: 'var(--fg-2)',
              fontFamily: 'var(--font-mono)',
            }}
          >
            {channel}
          </div>
          {/* wall-clock bottom-right (Telegram-style) — no view count per I-3 */}
          <span
            style={{
              fontSize: 11,
              color: 'var(--fg-3)',
              whiteSpace: 'nowrap',
            }}
          >
            {formatTimestamp(createdAt, !clock24)}
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

      {/* Hover toolbar — copy-link + arm-to-confirm delete. Positioned INSIDE the
          card (top:6) rather than NoteBubble's top:-10 because the card root is
          overflow:hidden (to clip the thumbnail corners), which would clip an
          outset bar. */}
      {showToolbar && (
        // biome-ignore lint/a11y/noStaticElementInteractions: wrapper only stops click propagation to the card; the real targets are the inner <button>s.
        // biome-ignore lint/a11y/useKeyWithClickEvents: inner buttons own keyboard activation; the wrapper has no keyboard semantics.
        <div
          onClick={(e) => e.stopPropagation()}
          style={{
            position: 'absolute',
            top: 6,
            right: 6,
            display: 'flex',
            gap: 2,
            background: '#fff',
            border: '1px solid var(--border-0)',
            borderRadius: 4,
            padding: 2,
            boxShadow: 'var(--shadow-1)',
          }}
        >
          {onCopyLink && (
            <button
              type="button"
              title="copy link"
              aria-label="copy link"
              onClick={(e) => {
                e.stopPropagation()
                onCopyLink()
              }}
              style={{ border: 0, background: 'transparent', cursor: 'pointer', padding: 4 }}
            >
              <Link2 size={14} />
            </button>
          )}
          {onDelete && (
            <button
              type="button"
              title="delete video"
              aria-label={deleteArmed ? 'confirm delete' : 'delete'}
              onClick={handleTrashClick}
              style={{
                border: 0,
                background: deleteArmed ? '#FDECEC' : 'transparent',
                cursor: 'pointer',
                padding: 4,
                color: deleteArmed ? '#E5484D' : 'inherit',
              }}
            >
              <Trash2 size={14} />
            </button>
          )}
        </div>
      )}
    </div>
  )
}
