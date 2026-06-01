import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronLeft, Clock, Columns2, Film, Rows2 } from 'lucide-react'
import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useHotkeys } from 'react-hotkeys-hook'
import { ScrollThumb, useScrollThumb } from '../components/ScrollArea'
import { api } from '../lib/api'
import { mediaUrlFromPath } from '../lib/media-url'
import { getPlayer } from '../yt/playerSingleton'
import { usePlayer } from '../yt/usePlayer'
import { JumpPill } from './JumpPill'
import { Rail } from './Rail'
import { activeClusterIndex, jumpPillDirection, markerPositions } from './rail-layout'
import { ThreadComposer } from './ThreadComposer'
import { TransportBar } from './TransportBar'
import { useThreadNotes } from './useThreadNotes'

/** ms the accent flash ring stays on a cluster after follow-scroll / click-to-seek. */
const FLASH_MS = 600

/** Playback-rate cycle for the transport speed badge. */
const RATES = [1, 1.25, 1.5, 1.75, 2]

/**
 * Centered content column width — matches ThreadView.jsx in the design-system
 * handoff (v21-design-system/v21-youtube-view-handoff/ThreadView.jsx line 51).
 *
 * Why: shared column for player, sort pill, notes, and composer so rail gutters
 * align correctly when the Rail lands in D4.
 */
const COL = 520

/** Smallest the player unit (video + transport) can be dragged down to. */
const MIN_VIDEO_W = 240

/** Split-view left-pane bounds (px). Max is `rowWidth - MIN_NOTES_W` at drag time. */
const MIN_SPLIT_W = 320
const MIN_NOTES_W = 360
const DEFAULT_SPLIT_W = 480

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

  // ── resizable player ────────────────────────────────────────────────────────
  // Drag the handle below the player to scale the whole player unit (video +
  // transport) between MIN_VIDEO_W and COL. The video keeps 16:9, so a narrower
  // unit is also shorter — that frees vertical space the notes column (flex:1)
  // immediately absorbs. Width-based (not height-based) keeps the image whole
  // and the transport bar aligned to the video. Drag DOWN = grow, UP = shrink.
  const [videoW, setVideoW] = useState<number | null>(null)
  const videoWidth = videoW ?? COL
  const onResizeStart = useCallback(
    (e: ReactPointerEvent) => {
      e.preventDefault()
      const startY = e.clientY
      const startW = videoW ?? COL
      const onMove = (ev: PointerEvent) => {
        const dy = ev.clientY - startY
        setVideoW(Math.max(MIN_VIDEO_W, Math.min(COL, startW + dy * (16 / 9))))
      }
      const onUp = () => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
    },
    [videoW],
  )

  // ── layout: stacked (video over notes) vs split (video beside notes) ─────────
  // Split anticipates a future left sidebar — the player becomes a left pane the
  // user can size with a vertical divider, leaving the notes pane to flex. The
  // <webview> is pinned to <body> and NEVER re-parented (moving it destroys its
  // guest — electron#9529); the toggle remounts the host placeholder, so we just
  // re-point the position-sync at the new placeholder after each switch.
  const [layout, setLayout] = useState<'stacked' | 'split'>('stacked')
  const [splitW, setSplitW] = useState<number | null>(null)
  const splitWidth = splitW ?? DEFAULT_SPLIT_W
  const rowRef = useRef<HTMLDivElement>(null)

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-point sync on layout switch; hostRef is stable
  useEffect(() => {
    if (hostRef.current) player.mount(hostRef.current)
  }, [layout])

  const onSplitResizeStart = useCallback(
    (e: ReactPointerEvent) => {
      e.preventDefault()
      const startX = e.clientX
      const startW = splitW ?? DEFAULT_SPLIT_W
      const rowW = rowRef.current?.getBoundingClientRect().width ?? 1200
      const max = Math.max(MIN_SPLIT_W, rowW - MIN_NOTES_W)
      const onMove = (ev: PointerEvent) => {
        setSplitW(Math.max(MIN_SPLIT_W, Math.min(max, startW + (ev.clientX - startX))))
      }
      const onUp = () => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
    },
    [splitW],
  )

  // ── playback rate (F1) ──────────────────────────────────────────────────────
  // Cycle through a fixed sequence on each speed-badge click and push the new
  // rate to the player. Kept here (not in TransportBar) so the badge stays a
  // pure presentational readout.
  const [rate, setRate] = useState(1)
  const cycleRate = useCallback(() => {
    setRate((r) => {
      const next = RATES[(RATES.indexOf(r) + 1) % RATES.length] ?? 1
      void player.setPlaybackRate(next)
      return next
    })
  }, [player])

  // ── follow auto-scroll · jump-pill · flash (spec §319–322) ──────────────────
  // The active cluster is the one the playhead currently sits in. `scrollRef`
  // owns the scrolling notes column; `flashClusterIdx` paints a transient accent
  // ring on a cluster after follow-scroll / click-to-seek (cleared after FLASH_MS).
  const activeIdx = activeClusterIndex(clusters, currentTime)
  const scrollRef = useRef<HTMLDivElement>(null)
  // The notes scroller, captured as state so the custom-scrollbar driver can
  // attach to it. The ref mirror (scrollRef) stays for scrollIntoView/measure.
  // The scroller is full-width (so the rail gutter's negative offsets aren't
  // clipped); the native bar is hidden and the custom thumb is drawn over the
  // centered column instead — matching the feed's center-only scrollbar.
  const [scrollerEl, setScrollerEl] = useState<HTMLDivElement | null>(null)
  const setScroller = useCallback((el: HTMLDivElement | null) => {
    scrollRef.current = el
    setScrollerEl(el)
    if (el) {
      el.classList.add('scroll-area-inner')
      el.style.scrollbarWidth = 'none'
    }
  }, [])
  const thumb = useScrollThumb(scrollerEl)
  const [flashClusterIdx, setFlashClusterIdx] = useState(-1)
  const flashTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  // null = hidden; 'up'/'down' = playhead is above/below the viewport.
  const [pillDir, setPillDir] = useState<'up' | 'down' | null>(null)

  // Scroll a cluster's row into view by its data-cluster-index, then flash it.
  // Why a selector (not refs): the row lives inside Rail; addressing it by a
  // stable data attribute keeps Rail's prop surface minimal. CRITICAL: this is
  // only ever called from explicit seek/follow — never from a scroll handler —
  // so scrolling the list can never move playback.
  const scrollClusterIntoView = useCallback((idx: number) => {
    if (idx < 0) return
    const el = scrollRef.current?.querySelector(`[data-cluster-index="${idx}"]`)
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    setFlashClusterIdx(idx)
    clearTimeout(flashTimerRef.current)
    flashTimerRef.current = setTimeout(() => setFlashClusterIdx(-1), FLASH_MS)
  }, [])

  // Follow auto-scroll: when follow is on and the active cluster changes, bring
  // it into view + flash. Keyed on [activeIdx, followOn] so toggling follow ON
  // re-syncs, and a playhead change with follow OFF does nothing.
  useEffect(() => {
    if (followOn && activeIdx >= 0) scrollClusterIntoView(activeIdx)
  }, [activeIdx, followOn, scrollClusterIntoView])

  // Jump-pill visibility: measure the active cluster's top vs the scroll
  // container's rect (predicate is pure — jumpPillVisible). The row's viewport
  // position only changes when the active cluster, sort/follow state, or the
  // user's scroll changes — so this is keyed on those, plus the onScroll handler.
  // Reading geometry here never seeks (no scroll→playback coupling).
  const measurePill = useCallback(() => {
    const container = scrollRef.current
    const row = container?.querySelector(`[data-cluster-index="${activeIdx}"]`)
    if (!container || !row) {
      setPillDir(null)
      return
    }
    const view = container.getBoundingClientRect()
    const playheadY = row.getBoundingClientRect().top
    setPillDir(
      jumpPillDirection({
        mode: sortMode,
        followOn,
        playheadY,
        viewTop: view.top,
        viewBottom: view.bottom,
      }),
    )
  }, [activeIdx, sortMode, followOn])

  // Re-measure when the measurement inputs (active cluster / sort / follow) change.
  useEffect(() => {
    measurePill()
  }, [measurePill])

  // Unmount cleanup: clear the flash timer so a pending setTimeout cannot call
  // setFlashClusterIdx on an unmounted tree. React 19 makes this a no-op in
  // practice, but clearing timers on unmount is the correct pattern.
  // Why empty dep array: this is a mount-only cleanup (fires only on unmount).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => () => clearTimeout(flashTimerRef.current), [])

  // ── capture → pending frame → post comment-note (spec §298–315) ────────────
  // A single pending frame per composer; capturing again REPLACES it. The chip
  // (and post anchor) use the captured moment's `t`, not the live playhead.
  const queryClient = useQueryClient()
  const [pendingFrame, setPendingFrame] = useState<{
    attachmentId: string
    thumbnailUrl: string
    t: number
  } | null>(null)
  // Surfaces the last failed post (e.g. duplicate-slug) in the composer, mirroring
  // the feed's inline error UX. Cleared on the next keystroke via onClearError.
  const [postError, setPostError] = useState<string | null>(null)

  // ⌘⇧C / camera button: screenshot the live webview rect at the current time.
  // No-op when no player is mounted (getMediaRect → null). On failure (e.g. the
  // main-process 0-area guard, #34) we leave pendingFrame untouched so no junk
  // chip appears. Why enableOnFormTags is OMITTED: the hotkey must NOT fire while
  // the composer textarea is focused (contrast App.tsx's mod+k which opts in).
  // @issue utof/linsae#34
  const onCapture = async () => {
    const player = getPlayer()
    const rect = player.getMediaRect()
    if (!rect) return
    try {
      const t = await player.getCurrentTime()
      const att = await api.youtube.capture(
        { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        videoId,
        t,
      )
      setPendingFrame({ attachmentId: att.id, thumbnailUrl: mediaUrlFromPath(att.path), t })
    } catch (err) {
      console.error('frame capture failed', err)
    }
  }
  useHotkeys('mod+shift+c', () => {
    void onCapture()
  })

  // Post a comment-note anchored to the captured `t` (capture-t wins over the
  // live chip when a frame is pending). The comment-on edge points at the video
  // note's SLUG. source_kind:'youtube' lets an empty-caption screenshot post
  // pass the empty-body Zod gate (NotesCreateInputSchema superRefine, A3). After
  // create, the pending attachment is linked to the new note.
  const post = useMutation({
    mutationFn: async ({ body, t }: { body: string; t: number }) => {
      // FIX 2: guard against posting before the video note has loaded — an
      // empty commentOn would create an orphan note with no thread parent.
      // Why: note resolves async; the composer is mounted before it settles.
      if (!note?.slug) throw new Error('video note not loaded')
      // FIX 1: snapshot pendingFrame at the top of the async fn to avoid a
      // stale-closure bug. If a second capture fires during the await below,
      // the re-assigned React state would make the SECOND capture's attachmentId
      // land on this (first) note — wrong. Using a local constant prevents that.
      const frame = pendingFrame
      const tAnchor = frame ? frame.t : t
      const created = await api.notes.create(body, 'claim', {
        source_kind: 'youtube',
        source_locator: { media: 'youtube', video_id: videoId, t: tAnchor },
        commentOn: note.slug,
      })
      if (frame) await api.attachments.attachToNote(frame.attachmentId, created.id)
      return created
    },
    onSuccess: () => {
      setPendingFrame(null)
      setPostError(null)
      void queryClient.invalidateQueries({ queryKey: ['notes'] })
      void queryClient.invalidateQueries({ queryKey: ['thread', noteId] })
    },
    // Surface failures (duplicate slug, empty-body gate, etc.) inline in the
    // composer instead of failing silently — same contract as the feed.
    onError: (err: Error) => setPostError(err.message),
  })

  // ── derived transport values ──────────────────────────────────────────────

  // Memoized so the array identity is stable across playhead ticks (sorted is
  // now memoized in useThreadNotes); otherwise TransportBar gets a fresh markers
  // array every ~5Hz tick. See #51.
  const markers = useMemo(
    () => markerPositions(sorted, duration).map((m) => m.t),
    [sorted, duration],
  )

  // ── render ────────────────────────────────────────────────────────────────

  // Player (video + transport) — rendered once in whichever layout is active.
  const playerContent = (
    <>
      <div
        style={{
          width: '100%',
          aspectRatio: '16 / 9',
          background: '#1c1c1e',
          borderRadius: 'var(--r-4) var(--r-4) 0 0',
          overflow: 'hidden',
        }}
      >
        <div ref={hostRef} data-testid="player-host" style={{ width: '100%', height: '100%' }} />
      </div>
      <TransportBar
        state={state}
        currentTime={currentTime}
        duration={duration}
        rate={rate}
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
        onRate={cycleRate}
        onToggleFollow={() => {
          setFollowOn((v) => !v)
        }}
        onFullscreen={() => {
          // Fullscreen the singleton's wrapper (the iframe fills it). Guarded
          // because requestFullscreen can be absent/rejected in some contexts.
          void player.wrapper?.requestFullscreen?.()
        }}
      />
    </>
  )

  // Sort row + scrollable notes + composer — the right side in split layout, the
  // lower stack in stacked. Internals are identical in both layouts.
  const notesPane = (
    <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      {/* SortPill lives OUTSIDE the scroller so changing sort never requires
          scrolling back to the top. */}
      <div style={{ flex: '0 0 auto', padding: '12px 24px 8px' }}>
        <div style={{ maxWidth: COL, margin: '0 auto' }}>
          <SortPill
            sortMode={sortMode}
            onToggle={() => setSortMode((m) => (m === 'video' ? 'capture' : 'video'))}
          />
        </div>
      </div>

      <div
        style={{ flex: 1, minHeight: 0, position: 'relative' }}
        onPointerEnter={thumb.onAreaEnter}
        onPointerLeave={thumb.onAreaLeave}
        onPointerMove={thumb.onAreaPointerMove}
      >
        <div
          ref={setScroller}
          data-testid="thread-scroll"
          onScroll={measurePill}
          style={{ height: '100%', overflowY: 'auto', padding: '4px 24px 10px' }}
        >
          <div style={{ maxWidth: COL, margin: '0 auto' }}>
            {/* The thread rendering: video-order rail (default) or capture feed. */}
            <Rail
              clusters={clusters}
              anchorless={anchorless}
              sorted={sorted}
              mode={sortMode}
              playheadT={currentTime}
              flashClusterIdx={flashClusterIdx}
              onSeekNote={(t) => {
                // Explicit seek ONLY — dot/time click. Seeking is never wired from
                // scroll, so scrolling the list cannot move playback.
                void player.seekTo(t)
                scrollClusterIntoView(activeClusterIndex(clusters, t))
              }}
            />
          </div>
        </div>

        {/* Custom scrollbar, constrained to the centered COL column. */}
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            justifyContent: 'center',
            pointerEvents: 'none',
          }}
        >
          <div style={{ position: 'relative', width: '100%', maxWidth: COL, height: '100%' }}>
            <ScrollThumb
              geometry={thumb.geometry}
              thumbHovered={thumb.thumbHovered}
              areaHovered={thumb.areaHovered}
              pointerNear={thumb.pointerNear}
              resizing={thumb.resizing}
              dragging={thumb.dragging}
              setThumbHovered={thumb.setThumbHovered}
              onPointerDown={thumb.onThumbPointerDown}
            />
          </div>
        </div>

        {/* Jump-to-now pill — top (arrow up) when "now" is above the viewport,
            bottom (arrow down) when below. */}
        {pillDir && (
          <div
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              ...(pillDir === 'up' ? { top: 14 } : { bottom: 14 }),
              display: 'flex',
              justifyContent: 'center',
              pointerEvents: 'none',
            }}
          >
            <span style={{ pointerEvents: 'auto' }}>
              <JumpPill
                seconds={currentTime}
                direction={pillDir}
                onJump={() => scrollClusterIntoView(activeIdx)}
              />
            </span>
          </div>
        )}
      </div>

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
            duration={duration}
            error={postError}
            onClearError={() => setPostError(null)}
            pendingFrame={
              pendingFrame ? { thumbnailUrl: pendingFrame.thumbnailUrl, t: pendingFrame.t } : null
            }
            onCapture={() => {
              void onCapture()
            }}
            onPost={({ body, t }) => {
              post.mutate({ body, t })
            }}
            onManualSeekEntry={(s) => {
              void player.seekTo(s)
            }}
          />
        </div>
      </div>
    </div>
  )

  return (
    <div
      style={{
        // flex:1 + minWidth:0 so ThreadView fills the body row in App.tsx — without
        // it the root shrinks to content width and pins left, leaving the centered
        // (margin:0 auto) columns hugging the left edge with dead space at right.
        flex: 1,
        minWidth: 0,
        height: '100%',
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        position: 'relative',
        background: 'var(--bg-0)',
      }}
    >
      {/* ── 1. Slim top bar ─────────────────────────────────────────────── */}
      {/* Inner content shares the centered COL column with the player, notes,
          and composer so the whole view reads as one column instead of a
          left-floating title beside a centered body. */}
      <header
        style={{
          flex: '0 0 auto',
          height: 46,
          padding: '0 24px',
          borderBottom: '1px solid var(--border-0)',
        }}
      >
        <div
          style={{
            maxWidth: COL,
            margin: '0 auto',
            height: '100%',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
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
              marginLeft: -8,
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
          <div style={{ flex: 1 }} />
          {/* Layout toggle: stacked (video over notes) ↔ split (side-by-side).
              Icon shows the layout you'll switch TO. */}
          <button
            type="button"
            aria-label="toggle layout"
            title={layout === 'stacked' ? 'side-by-side view' : 'stacked view'}
            onClick={() => setLayout((l) => (l === 'stacked' ? 'split' : 'stacked'))}
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
              marginRight: -8,
            }}
          >
            {layout === 'stacked' ? <Columns2 size={16} /> : <Rows2 size={16} />}
          </button>
        </div>
      </header>

      {layout === 'stacked' ? (
        <>
          {/* ── Player on top ─────────────────────────────────────────────── */}
          <div style={{ flex: '0 0 auto', padding: '14px 24px 12px' }}>
            <div style={{ maxWidth: videoWidth, margin: '0 auto' }}>{playerContent}</div>
          </div>
          {/* Horizontal resize handle — drag to scale the player; notes take the
              freed vertical space. */}
          <div
            onPointerDown={onResizeStart}
            title="drag to resize the player"
            aria-hidden
            data-testid="player-resize"
            style={{
              flex: '0 0 auto',
              height: 11,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'row-resize',
              borderBottom: '1px solid var(--border-0)',
            }}
          >
            <span
              style={{ width: 36, height: 3, borderRadius: 2, background: 'var(--border-2)' }}
            />
          </div>
          {notesPane}
        </>
      ) : (
        // ── Side-by-side: player pane | vertical divider | notes pane ────────
        <div ref={rowRef} style={{ flex: 1, minHeight: 0, display: 'flex' }}>
          <div
            style={{
              width: splitWidth,
              flexShrink: 0,
              minWidth: 0,
              overflowY: 'auto',
              padding: '14px 16px',
            }}
          >
            {playerContent}
          </div>
          <div
            onPointerDown={onSplitResizeStart}
            title="drag to resize the video"
            aria-hidden
            data-testid="player-resize-v"
            style={{
              flex: '0 0 auto',
              width: 11,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'col-resize',
              borderRight: '1px solid var(--border-0)',
            }}
          >
            <span
              style={{ width: 3, height: 36, borderRadius: 2, background: 'var(--border-2)' }}
            />
          </div>
          {notesPane}
        </div>
      )}
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
