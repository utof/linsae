/**
 * MediaFeedNote — a YouTube video as it appears in the v21 chronological feed.
 * ============================================================================
 * The video is a Source note; in the daily feed it renders as this card, and
 * its annotations live behind the "open video notes" thread button.
 *
 * DECISIONS WE AGREED ON (do not silently revert):
 *   ✓ Variant A "integrated bottom row" (the Telegram pattern). The thread
 *     button IS the card's last row, divided by a hairline. We compared a
 *     detached callout (B) and a horizontal pill (C) and chose A.
 *   ✓ NO "VIDEO" type tag / no purple Source chip — the thumbnail already makes
 *     it obvious. (We removed it.)
 *   ✓ Wall-clock time (when the note entered the feed) + the view count sit at
 *     the BOTTOM-RIGHT of the note content — like Telegram's "👁 1  6:16 PM".
 *     They are NOT placed inside the thread-button callout.
 *   ✓ Thread button label: "open video notes", in ACCENT (it's the action),
 *     with the note count and open-question count on the right + a chevron.
 *   ✓ "{n} open" uses the Question amber — it's status (unresolved questions),
 *     the one bit of semantic color we keep here. Drop it if you want it quieter.
 *
 * TOKENS: expects the v21 design-system CSS variables to be loaded globally.
 * The only hardcoded values are the dark thumbnail (#1c1c1e) and its overlays.
 */
import React from 'react';
import { Play, MessagesSquare, ChevronRight, Eye } from 'lucide-react';

export default function MediaFeedNote({
  title = 'Serre spectral sequences — lecture 9 (fibrations, day 2)',
  channel = 'math 232B',
  duration = '37:20',
  views = '14K',          // YouTube view count (swap for whatever metric you store)
  addedAt = '9:15',       // wall-clock time the note entered the feed
  noteCount = 12,
  openCount = 2,
  thumbnailSrc,           // optional <img> src; falls back to the dark rect
  onPlay,
  onOpenThread,
}) {
  return (
    <div style={{ maxWidth: 360, background: '#fff', border: '1px solid var(--border-0)', borderRadius: 'var(--r-4)', overflow: 'hidden' }}>
      {/* thumbnail (plain dark 16:9; play badge + duration) */}
      <button onClick={onPlay} style={{ all: 'unset', display: 'block', cursor: 'pointer', width: '100%' }}>
        <div style={{ width: '100%', aspectRatio: '16 / 9', background: '#1c1c1e', position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
          {thumbnailSrc && <img src={thumbnailSrc} alt="" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} />}
          <div style={{ position: 'relative', width: 38, height: 38, borderRadius: '50%', background: 'rgba(255,255,255,0.16)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Play size={16} color="#fff" />
          </div>
          <span style={{ position: 'absolute', right: 6, bottom: 6, fontFamily: 'var(--font-mono)', fontSize: 10, color: '#fff', background: 'rgba(0,0,0,0.72)', padding: '1px 5px', borderRadius: 3 }}>{duration}</span>
        </div>
      </button>

      {/* title + meta, with time/views BOTTOM-RIGHT (not in the callout) */}
      <div style={{ padding: '10px 12px' }}>
        <div style={{ fontSize: 14, fontWeight: 500, color: 'var(--fg-0)', lineHeight: 'var(--lh-snug)' }}>{title}</div>
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 10, marginTop: 4 }}>
          <div style={{ fontSize: 12, color: 'var(--fg-2)', fontFamily: 'var(--font-mono)' }}>{channel} · {duration}</div>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--fg-3)', whiteSpace: 'nowrap' }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}><Eye size={12} />{views}</span>
            <span>{addedAt}</span>
          </div>
        </div>
      </div>

      {/* thread button — the card's last row (Telegram-style). No time here. */}
      <button onClick={onOpenThread} style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', cursor: 'pointer', border: 0, borderTop: '1px solid var(--border-0)', background: 'transparent', padding: '10px 12px' }}>
        <MessagesSquare size={16} color="var(--accent)" />
        <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--accent)' }}>open video notes</span>
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 12, color: 'var(--fg-2)', whiteSpace: 'nowrap' }}>
          {noteCount} notes{openCount ? <> · <span style={{ color: 'var(--type-question)' }}>{openCount} open</span></> : null}
        </span>
        <ChevronRight size={15} color="var(--fg-3)" />
      </button>
    </div>
  );
}
