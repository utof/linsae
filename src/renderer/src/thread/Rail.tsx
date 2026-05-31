/**
 * Rail — the video-order thread rendering (and its capture-order fallback).
 *
 * VIDEO mode (the distinctive view): a left rail gutter with a vertical line.
 * Each anchored cluster gets ONE dot + ONE timestamp in the gutter; the
 * cluster's notes stack tightly under it (a same-pause cluster = one dot, many
 * notes). Between consecutive clusters a collapsed dead-air `Gap` (three dots,
 * the rail line broken behind a background mask) whose height is logarithmic in
 * the minutes skipped. An accent `Playhead` marker sits at the active cluster
 * (greatest `t` <= playheadT). Timestamp-free notes float to the bottom under a
 * `PinOff` hairline divider — they never lie about a rail position.
 *
 * CAPTURE mode: the ordinary chronological feed — the flat `sorted` list of the
 * same neutral bubbles, with NO rail line / dots / gaps / playhead (capture
 * order has no timestamp geometry). The anchorless notes are already interleaved
 * into `sorted` by `sortForMode`, so we render `sorted` directly.
 *
 * Notes are NEUTRAL: no per-type colors / labels. Accent marks ONLY the
 * current/active (playhead). Decisions are documented in the design handoff
 * (do not silently revert): see the visual source below.
 *
 * Visual source: v21-design-system/v21-youtube-view-handoff/ThreadView.jsx
 * (rail sub-components, lines 104–155; VideoOrder/CaptureOrder lines 238–273).
 *
 * @see src/renderer/src/thread/useThreadNotes.ts
 * @see src/renderer/src/thread/rail-layout.ts
 * @see docs/specs/v0.2-youtube-annotation.md §ThreadView
 */

import { PinOff } from 'lucide-react'
import type { Attachment, Note } from '../../../shared/types'
import { Markdown } from '../lib/markdown'
import { mediaUrlFromPath } from '../lib/media-url'
import { formatClock } from '../lib/time'
import { activeClusterIndex, logGapHeight } from './rail-layout'

// ── layout constants (shared column + its left rail gutter) ─────────────────
// Mirrors the design handoff: RAIL = rail-line x relative to the column's left
// edge; DOTC = the dot's visual center. The content column itself is owned by
// ThreadView; Rail draws into the gutter to its LEFT via negative offsets.
const RAIL = -20
const DOTC = RAIL + 1
// The only blessed hardcoded color in this area is the dark media frame.
const MEDIA_BG = '#1c1c1e'

/**
 * A thread item as produced by `useThreadNotes`. Structural shape — Rail does
 * not import the hook's non-exported `ThreadItem` type (knip would flag an
 * export with only a test consumer).
 */
interface RailItem {
  id: string
  t: number | null
  createdAt: number
  note: Note
  attachment: Attachment | null
}

interface RailCluster {
  t: number
  notes: RailItem[]
}

/** Props for {@link Rail}. */
export interface RailProps {
  /** Anchored clusters (video mode), already sorted by `t` asc. */
  clusters: RailCluster[]
  /** Notes with no timestamp — float to the bottom under the divider. */
  anchorless: RailItem[]
  /** Capture-ordered flat list (used in capture mode). */
  sorted: RailItem[]
  /** Active sort mode. */
  mode: 'video' | 'capture'
  /** Current playback position in seconds (selects the active cluster). */
  playheadT: number
  /** Called with a cluster's `t` when its dot/time is clicked. */
  onSeekNote: (t: number) => void
  /**
   * Index of a cluster to flash with a transient accent ring (set by ThreadView
   * on follow-scroll / click-to-seek, cleared after a short timeout). `-1` = none.
   */
  flashClusterIdx?: number
}

/** A neutral note bubble: screenshot frame (if any) fills the bubble, body below. */
function NoteBubble({ item, active }: { item: RailItem; active: boolean }) {
  return (
    <div
      data-testid="rail-note"
      style={{
        background: '#fff',
        border: `1px solid ${active ? 'var(--accent)' : 'var(--border-0)'}`,
        borderRadius: 'var(--r-5)',
        padding: '9px 11px',
        boxShadow: active ? '0 0 0 3px var(--accent-tint)' : 'none',
      }}
    >
      {item.attachment && (
        <div
          style={{
            marginBottom: item.note.body ? 8 : 0,
            width: '100%',
            aspectRatio: '16 / 9',
            overflow: 'hidden',
            borderRadius: 'var(--r-3)',
            background: MEDIA_BG,
          }}
        >
          <img
            src={mediaUrlFromPath(item.attachment.base_path)}
            alt="captured frame"
            style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }}
          />
        </div>
      )}
      {item.note.body && (
        <div style={{ fontSize: 14, lineHeight: 'var(--lh-normal)', color: 'var(--fg-1)' }}>
          <Markdown body={item.note.body} onWikilinkClick={NOOP} />
        </div>
      )}
    </div>
  )
}

/** Thread-local wikilink clicks are out of scope here (deferred to a later batch). */
const NOOP = (): void => {}

/** One cluster: dot + time in the gutter; the cluster's notes stacked under it. */
function ClusterRow({
  cluster,
  index,
  active,
  flash,
  onSeek,
}: {
  cluster: RailCluster
  index: number
  active: boolean
  flash: boolean
  onSeek: (t: number) => void
}) {
  return (
    <div
      // data-cluster-index lets ThreadView address this row for scrollIntoView
      // without Rail holding refs. The flash ring is a transient accent outline
      // (outline doesn't shift layout) applied while ThreadView marks it.
      data-cluster-index={index}
      style={{
        position: 'relative',
        marginBottom: 22,
        borderRadius: 'var(--r-5)',
        outline: flash ? '2px solid var(--accent)' : '2px solid transparent',
        outlineOffset: 3,
        transition: 'outline-color var(--dur-2) ease',
      }}
    >
      <button
        type="button"
        data-testid="rail-time"
        aria-label={`seek to ${formatClock(cluster.t)}`}
        onClick={() => onSeek(cluster.t)}
        style={{
          position: 'absolute',
          left: -76,
          top: 11,
          width: 44,
          textAlign: 'right',
          border: 0,
          background: 'transparent',
          padding: 0,
          cursor: 'pointer',
          fontFamily: 'var(--font-mono)',
          fontSize: 11,
          fontWeight: active ? 600 : 400,
          color: active ? 'var(--accent)' : 'var(--fg-3)',
        }}
      >
        {formatClock(cluster.t)}
      </button>
      <button
        type="button"
        data-testid="rail-dot"
        aria-label={`seek to ${formatClock(cluster.t)}`}
        onClick={() => onSeek(cluster.t)}
        style={{
          position: 'absolute',
          left: DOTC - 4.5,
          top: 13,
          width: 9,
          height: 9,
          borderRadius: '50%',
          padding: 0,
          background: active ? 'var(--accent)' : 'var(--fg-3)',
          border: '2px solid var(--bg-0)',
          cursor: 'pointer',
          zIndex: 2,
        }}
      />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {cluster.notes.map((it) => (
          <NoteBubble key={it.id} item={it} active={active} />
        ))}
      </div>
    </div>
  )
}

/** Collapsed dead-air: three dots; the rail line breaks behind a bg mask. */
function Gap({ minutes }: { minutes: number }) {
  return (
    <div
      data-testid="rail-gap"
      title={`${Math.round(minutes)} min skipped`}
      style={{ position: 'relative', height: logGapHeight(minutes) }}
    >
      <span
        style={{
          position: 'absolute',
          left: RAIL - 3,
          top: 0,
          bottom: 0,
          width: 8,
          background: 'var(--bg-0)',
        }}
      />
      <div
        style={{
          position: 'absolute',
          left: DOTC - 1.75,
          top: '50%',
          transform: 'translateY(-50%)',
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
        }}
      >
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            style={{ width: 3.5, height: 3.5, borderRadius: '50%', background: 'var(--border-2)' }}
          />
        ))}
      </div>
    </div>
  )
}

/** Accent marker at the active playback position. */
function Playhead({ t }: { t: number }) {
  return (
    <div data-testid="rail-playhead" style={{ position: 'relative', height: 16, marginBottom: 22 }}>
      <span
        style={{
          position: 'absolute',
          left: -76,
          top: 1,
          width: 44,
          textAlign: 'right',
          fontFamily: 'var(--font-mono)',
          fontSize: 11,
          fontWeight: 600,
          color: 'var(--accent)',
        }}
      >
        {formatClock(t)}
      </span>
      <span
        style={{
          position: 'absolute',
          left: DOTC - 6.5,
          top: 1,
          width: 13,
          height: 13,
          borderRadius: '50%',
          background: 'var(--accent)',
          border: '2px solid #fff',
          boxShadow: '0 0 0 1.5px var(--accent)',
          zIndex: 3,
        }}
      />
      <span
        style={{
          position: 'absolute',
          left: -6,
          right: 0,
          top: 7,
          borderTop: '1.5px solid var(--accent)',
          opacity: 0.35,
        }}
      />
    </div>
  )
}

/** @see RailProps */
export function Rail({
  clusters,
  anchorless,
  sorted,
  mode,
  playheadT,
  onSeekNote,
  flashClusterIdx = -1,
}: RailProps) {
  if (mode === 'capture') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {sorted.map((it) => (
          <NoteBubble key={it.id} item={it} active={false} />
        ))}
      </div>
    )
  }

  const activeIdx = activeClusterIndex(clusters, playheadT)

  return (
    <div style={{ position: 'relative' }}>
      {/* the rail line (broken by Gap masks) */}
      <span
        style={{
          position: 'absolute',
          left: RAIL,
          top: 4,
          bottom: 4,
          width: 2,
          background: 'var(--border-1)',
        }}
      />
      {/* playhead before the first cluster when the position precedes all anchors */}
      {activeIdx === -1 && <Playhead t={playheadT} />}
      {clusters.map((cluster, i) => {
        const prev = clusters[i - 1]
        return (
          <div key={cluster.t}>
            {prev !== undefined && <Gap minutes={(cluster.t - prev.t) / 60} />}
            <ClusterRow
              cluster={cluster}
              index={i}
              active={i === activeIdx}
              flash={i === flashClusterIdx}
              onSeek={onSeekNote}
            />
            {i === activeIdx && <Playhead t={playheadT} />}
          </div>
        )
      })}
      {anchorless.length > 0 && (
        <div style={{ marginTop: 6 }}>
          <div
            data-testid="anchorless-divider"
            style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '0 0 10px' }}
          >
            <span style={{ flex: 1, height: 1, background: 'var(--border-0)' }} />
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
                fontSize: 11,
                color: 'var(--fg-3)',
              }}
            >
              <PinOff size={11} /> thread notes · no timestamp
            </span>
            <span style={{ flex: 1, height: 1, background: 'var(--border-0)' }} />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {anchorless.map((it) => (
              <NoteBubble key={it.id} item={it} active={false} />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
