import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronLeft, Clock, Film } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useHotkeys } from 'react-hotkeys-hook'
import type { Attachment } from '../../../shared/types'
import { AnnotateEditor } from '../annotate/AnnotateEditor'
import { ReopenEditor } from '../annotate/ReopenEditor'
import { ScrollThumb, useScrollThumb } from '../components/ScrollArea'
import { ScrollDatePill } from '../feed/DatePills'
import { NoteBubble } from '../feed/NoteBubble'
import { api } from '../lib/api'
import { useSetSetting } from '../lib/use-setting'
import { useDockStore } from '../panes/dockStore'
import { getPlayer } from '../yt/playerSingleton'
import { usePlayerState } from '../yt/usePlayerState'
import { JumpPill } from './JumpPill'
import { Rail } from './Rail'
import { activeClusterIndex, jumpPillDirection } from './rail-layout'
import { SimpleComposer } from './SimpleComposer'
import { ThreadComposer } from './ThreadComposer'
import { ThreadRoot } from './ThreadRoot'
import { useThreadNotes } from './useThreadNotes'

/** ms the accent flash ring stays on a cluster after follow-scroll / click-to-seek. */
const FLASH_MS = 600

/**
 * Trailing-throttle window (ms) for reporting the generic (plain/pdf) thread's
 * scrollTop up to App for persistence (`thread.scroll.v1`, v0.7 Task 2.2). One
 * report per window while the user scrolls; the trailing edge reads the FINAL
 * position off the live element, so a settle always persists the last offset.
 *
 * @see docs/plans/v0.7-session-persistence.md §Task 2.2
 */
const SCROLL_PERSIST_THROTTLE_MS = 200

/**
 * Centered content column width — matches ThreadView.jsx in the design-system
 * handoff (v21-design-system/v21-youtube-view-handoff/ThreadView.jsx line 51).
 *
 * Why: shared column for sort pill, notes, and composer so rail gutters align
 * correctly. After B5 the player lives in the right-dock PlayerPane, not here.
 */
const COL = 520

/**
 * ThreadView — shell for a single note thread.
 *
 * Regions (top → bottom):
 *   1. Slim top bar: back button + note/video title.
 *   2. Scrollable content column: SortPill (YouTube only) + note list (Rail or
 *      NoteBubble list) + composer.
 *
 * YouTube-thread behaviour:
 * - On mount (once videoId resolves) writes `'player.videoId'` setting and calls
 *   `openPane('player')` so the right-dock PlayerPane shows the player (B5).
 * - Reads playback state (currentTime / duration) from `usePlayerState` for the
 *   Rail, follow-scroll, and duration write-back; the SINGLETON MOUNT lives in
 *   PlayerPane — ThreadView never calls `player.mount()` directly (ADR 0016).
 * - Duration write-back (I-4): when `duration` first becomes non-null on this
 *   mount, `api.videoSources.upsert` is called once with `{ durationSec }`.
 * - `followOn` defaults to true per spec §TransportBar.
 * - Sort defaults to 'video' (video-time order); pill toggles to 'capture'.
 *
 * Visual source: v21-design-system/v21-youtube-view-handoff/ThreadView.jsx
 * (shell region lines 276–334).
 *
 * @see src/renderer/src/yt/PlayerPane.tsx (holds the player placeholder, B5)
 * @see src/renderer/src/yt/usePlayerState.ts (read-only playback state)
 * @see src/renderer/src/thread/useThreadNotes.ts
 * @see src/renderer/src/thread/rail-layout.ts
 * @see docs/specs/v0.2-youtube-annotation.md §ThreadView
 * @see docs/plans/v0.6.4-notes-as-threads.md §Task 5.1
 */
export interface ThreadViewProps {
  /** UUID of the source-type note representing the video. */
  noteId: string
  /** Called when the user presses the back button. */
  onClose: () => void
  /**
   * Wikilink resolver from the app level — resolves `[[slug]]` clicks to note
   * navigation or dangling-draft prefill. Passed through to both `ThreadRoot`
   * (root header) and `NoteBubble` children in the generic plain/pdf branch,
   * satisfying spec §"Wikilink navigation in thread cards".
   *
   * Optional: the generic branch falls back to a no-op when absent (e.g. in
   * tests that do not wire a navigator). The YouTube branch does not use this
   * prop (Rail uses a NOOP internally; youtube child notes navigate by seek).
   *
   * Why: `App.tsx` owns the resolver (api.links.resolve → setFocusedId or
   * dangling-draft). Threading it down as a prop is the minimal, YAGNI path
   * without introducing a context or global store for a single call-site.
   *
   * @see src/renderer/src/App.tsx (onWikilinkClick)
   */
  onWikilinkClick?: (slug: string) => void
  /**
   * Restored scrollTop for THIS thread's root, applied ONCE to the generic
   * (plain/pdf) scroller after its children establish scrollHeight (v0.7 Task 2.2).
   * App sources it from `snap.data.threadScroll[rootId]`. Undefined = no restore.
   *
   * YouTube threads deliberately IGNORE this: their always-on playhead-follow
   * auto-scroll re-scrolls every tick, so a restored offset would be clobbered
   * instantly. The youtube layout (`notesPane`) never reads this prop — the
   * exclusion is structural (App can't reliably know the root's kind, so
   * ThreadView, which fetches the note, owns the gate).
   *
   * @see docs/plans/v0.7-session-persistence.md §Task 2.2
   */
  // `| undefined` (not just `?`) so App can forward `threadScrollMap[id]` (a
  // possibly-absent lookup) directly under `exactOptionalPropertyTypes`.
  initialScrollTop?: number | undefined
  /**
   * Trailing-throttled report of the generic (plain/pdf) scroller's scrollTop, for
   * App-owned persistence to `thread.scroll.v1`. NOT attached for youtube threads
   * (the playhead-follow owns scroll there). @see initialScrollTop
   */
  onScroll?: (scrollTop: number) => void
  /**
   * Restored composer draft text for THIS thread's root, forwarded to BOTH the
   * youtube `ThreadComposer` and the plain/pdf `SimpleComposer` as their
   * `initialDraft` (v0.7 Task 4.2). Unlike `initialScrollTop` (which youtube
   * ignores), drafts apply to every branch. App sources it from
   * `snap.data.draftThread[rootId]`. @see docs/plans/v0.7-session-persistence.md §Task 4.2
   */
  // `| undefined` (not just `?`) so App can forward `draftThreadMap[id]` (a
  // possibly-absent lookup) directly under `exactOptionalPropertyTypes`.
  initialDraft?: string | undefined
  /**
   * Live draft-text reporter, forwarded to both composers. App keys it by the
   * thread root id and persists to `composer.draft.thread.v1`. @see initialDraft
   */
  onDraftChange?: (text: string) => void
  /**
   * Called on a real send from either composer, forwarded to both. App drops
   * this root's entry from the draft map. @see initialDraft
   */
  onDraftClear?: () => void
}

/** @see ThreadViewProps */
export function ThreadView({
  noteId,
  onClose,
  onWikilinkClick,
  initialScrollTop,
  onScroll,
  initialDraft,
  onDraftChange,
  onDraftClear,
}: ThreadViewProps) {
  // ── data fetches ──────────────────────────────────────────────────────────

  const { data: note } = useQuery({
    queryKey: ['note', noteId],
    queryFn: () => api.notes.get(noteId),
    enabled: !!noteId,
  })

  /**
   * Derived note kind — drives the branch in the render section.
   * Defaults to 'plain' while `note` is still loading (undefined) so the
   * generic branch renders an empty placeholder; switches to 'youtube' once the
   * note resolves, re-rendering into the player/Rail layout. Intermediate
   * renders are invisible (thread has no data yet).
   *
   * Why not 'youtube' while loading: we'd briefly render the player host +
   * youtube-specific state before the note confirms it's a video note, which
   * could attach the player singleton for a non-video note. Defaulting to
   * 'plain' is the safe, visually-silent choice.
   *
   * @see docs/plans/v0.6.4-notes-as-threads.md §Task 2.3
   */
  const kind =
    note?.source_kind === 'youtube' ? 'youtube' : note?.source_kind === 'pdf' ? 'pdf' : 'plain'

  const videoId = note?.source_locator?.media === 'youtube' ? note.source_locator.video_id : ''

  const { data: videoSource } = useQuery({
    queryKey: ['videoSource', videoId],
    queryFn: () => api.videoSources.get(videoId),
    enabled: !!videoId,
  })

  const title = kind === 'youtube' ? (videoSource?.title ?? videoId) : (note?.slug ?? '')

  // ── playback state (read-only; mount lives in PlayerPane — B5) ──────────────
  // usePlayerState subscribes to the singleton's state and polls currentTime/
  // duration at ~5 Hz WITHOUT calling player.mount() or player.load(). The SOLE
  // mount is in PlayerPane (right dock). Single-mount invariant: ADR 0016.
  const { player, currentTime, duration } = usePlayerState(videoId)

  // ── open the player pane when a youtube thread loads ──────────────────────
  // Write 'player.videoId' so PlayerPane's useSetting can read it, then open
  // the right-dock 'player' pane. Fire-and-forget the async DB write; the
  // openPane call is synchronous (Zustand) so the dock opens immediately.
  // Guard: videoId is '' for plain/pdf notes — skip in those cases.
  // Why: mirrors how the PDF open flow writes 'pdf.openDocId' before the pane
  // renders. @see src/renderer/src/pdf/usePdfOpenId.ts (useOpenPdf)
  const setVideoId = useSetSetting('player.videoId')
  useEffect(() => {
    if (!videoId) return
    void setVideoId.mutateAsync(videoId)
    useDockStore.getState().openPane('player')
  }, [videoId, setVideoId.mutateAsync])

  // ── open the PDF pane when a PDF thread loads ─────────────────────────────
  // Mirrors the YouTube openPane('player') effect above — when the thread's root
  // note is a PDF source note, write 'pdf.openDocId' (so PdfReader shows the
  // correct document) and open the right-dock 'pdf' pane synchronously.
  // Guard: pdfId is '' for youtube/plain notes — no-op in those cases.
  // Idempotent: openPane is a no-op when already active; the setting write is
  // the same value, so no observable churn.
  // Why: drilling into a PDF thread via the feed's "open notes" affordance goes
  // through setThreadNoteId (NOT through onOpenPdf / the file-picker flow), so
  // the pane was never opened by that path — this effect is the missing link.
  // Re-open contract: ThreadView unmounts on back-navigation (threadNoteId→null)
  // so every thread-open mounts a fresh instance; on remount this effect fires
  // once, re-opening a pane the user had previously closed. (#166)
  // @see src/renderer/src/pdf/usePdfOpenId.ts (useOpenPdf — sets the setting)
  // @see src/renderer/src/App.tsx (handlePaneClose — clears the setting on close)
  const setPdfOpenId = useSetSetting('pdf.openDocId')
  const pdfId = note?.source_locator?.media === 'pdf' ? note.source_locator.pdf_id : ''
  useEffect(() => {
    if (!pdfId) return
    void setPdfOpenId.mutateAsync(pdfId)
    useDockStore.getState().openPane('pdf')
  }, [pdfId, setPdfOpenId.mutateAsync])

  // ── duration write-back (I-4) ─────────────────────────────────────────────
  // Write the resolved duration back to video_sources exactly once per mount.
  // A ref flag prevents repeat writes under React StrictMode double-invoke.
  // Why: getDuration() is 0 until the video is cued, so we write only after
  // usePlayerState's re-poll yields a non-null value.
  //
  // @see src/renderer/src/yt/usePlayerState.ts (I-4 comment in the rAF loop)
  const durationWrittenRef = useRef(false)
  useEffect(() => {
    if (!videoId || duration == null || durationWrittenRef.current) return
    durationWrittenRef.current = true
    // Round: the guest reports video.duration as a float (e.g. 213.04) but the
    // VideoSourcesUpsertInput Zod schema requires an int (zod-schemas.ts §durationSec).
    // The float is kept everywhere else (the scrubber needs sub-second precision); we
    // only round at the persist boundary.
    void api.videoSources.upsert(videoId, { durationSec: Math.round(duration) })
  }, [videoId, duration])

  // ── sort + thread notes ───────────────────────────────────────────────────

  const [sortMode, setSortMode] = useState<'video' | 'capture'>('video')
  // plain/pdf use chronological order; youtube respects the user-toggled sortMode.
  // The query key is always ['thread', noteId] — sortMode only affects local derivation.
  const effectiveSortMode = kind === 'youtube' ? sortMode : 'capture'
  const { sorted, clusters, anchorless } = useThreadNotes(noteId, effectiveSortMode)

  // ── follow state ──────────────────────────────────────────────────────────
  // After B5 the follow-toggle lived in TransportBar (now in PlayerPane).
  // ThreadView defaults follow to always-on; the toggle is surfaced in the
  // player pane in a future task.
  const followOn = true

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

  // Follow auto-scroll: always on after B5 (toggle was in TransportBar).
  useEffect(() => {
    if (activeIdx >= 0) scrollClusterIntoView(activeIdx)
  }, [activeIdx, scrollClusterIntoView])

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
  }, [activeIdx, sortMode])

  // Re-measure when the measurement inputs (active cluster / sort / follow) change.
  useEffect(() => {
    measurePill()
  }, [measurePill])

  // ── floating date pill (capture view only) ──────────────────────────────────
  // Capture order is chronological, so the notes carry `data-day` (Rail) and we
  // label the pill with the topmost visible note's day, fading 800ms after scroll
  // stops — same idea as the feed's ScrollDatePill, but DOM-measured (the thread
  // isn't virtualized). Video order has no date monotonicity, so the pill is off there.
  const [datePill, setDatePill] = useState<string | null>(null)
  const [datePillVisible, setDatePillVisible] = useState(false)
  const datePillIdleRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  const updateDatePill = useCallback(() => {
    if (sortMode !== 'capture') return
    const el = scrollRef.current
    if (!el) return
    const top = el.getBoundingClientRect().top
    const days = Array.from(el.querySelectorAll<HTMLElement>('[data-day]'))
    const topDay = days.find((d) => d.getBoundingClientRect().bottom > top + 1)
    setDatePill(topDay?.dataset.day ?? null)
    setDatePillVisible(true)
    clearTimeout(datePillIdleRef.current)
    datePillIdleRef.current = setTimeout(() => setDatePillVisible(false), 800)
  }, [sortMode])
  const onNotesScroll = useCallback(() => {
    measurePill()
    updateDatePill()
  }, [measurePill, updateDatePill])
  // Clear the date-pill idle timer on unmount.
  useEffect(() => () => clearTimeout(datePillIdleRef.current), [])

  // Unmount cleanup: clear the flash timer so a pending setTimeout cannot call
  // setFlashClusterIdx on an unmounted tree. React 19 makes this a no-op in
  // practice, but clearing timers on unmount is the correct pattern.
  // Why empty dep array: this is a mount-only cleanup (fires only on unmount).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => () => clearTimeout(flashTimerRef.current), [])

  // ── capture → editor → pending frame → post comment-note (spec §Capture-time) ─
  // A single pending frame per composer; capturing again REPLACES it. The chip
  // (and post anchor) use the captured moment's `t`, not the live playhead. The
  // pending frame now carries the synthesized Attachment so the chip can render
  // the (possibly annotated) frame via AnnotatedFrame (v0.2.5).
  const queryClient = useQueryClient()
  const [pendingFrame, setPendingFrame] = useState<{ attachment: Attachment; t: number } | null>(
    null,
  )
  // Surfaces the last failed post (e.g. duplicate-slug) in the composer, mirroring
  // the feed's inline error UX. Cleared on the next keystroke via onClearError.
  const [postError, setPostError] = useState<string | null>(null)

  // ── reopen-a-posted-screenshot (T4.2) ──────────────────────────────────────
  // When set, the ReopenEditor modal is mounted for this attachment (hover-pencil
  // on a Rail frame). Done invalidates ['thread', noteId] so the Rail re-reads the
  // new overlay_path (B-4). null = closed.
  const [reopenAttachment, setReopenAttachment] = useState<Attachment | null>(null)

  // ── capture-time editor (T4.3) ──────────────────────────────────────────────
  // After ⌘⇧C captures an orphan frame, the editor opens on the synthesized
  // Attachment (escMode='orphan'). Done → pending chip; Esc → discard/keep-orphan.
  // null = no capture editor open. A capture/reopen editor being open makes ⌘⇧C a
  // no-op (re-entrancy guard). `t` is the captured moment for the eventual chip.
  const [captureFrame, setCaptureFrame] = useState<{ attachment: Attachment; t: number } | null>(
    null,
  )
  const editorOpen = captureFrame !== null || reopenAttachment !== null
  // C3: the editorOpen flag only flips true AFTER the capture awaits resolve, so a
  // second ⌘⇧C (or OS key auto-repeat) in that window would slip past the guard and
  // fire a duplicate youtube.capture → a leaked orphan row + PNG. This ref is set
  // synchronously BEFORE the first await and cleared in finally, closing that gap.
  const captureInFlightRef = useRef(false)

  // ⌘⇧C / camera button: screenshot the live webview rect at the current time,
  // then OPEN THE EDITOR on the captured frame (v0.2.5 — the editor opens before
  // the pending chip). No-op when no player is mounted (getMediaRect → null), an
  // editor is already open, OR a capture is already in flight (re-entrancy guard).
  // On failure (e.g. the main-process 0-area guard, #34) we leave state untouched
  // so no junk appears. Why enableOnFormTags is OMITTED: the hotkey must NOT fire
  // while the composer textarea is focused (contrast App.tsx's mod+k which opts in).
  // @issue utof/linsae#34
  const onCapture = async () => {
    // Re-entrancy guard: ignore while an editor is open OR a capture is in flight.
    if (editorOpen || captureInFlightRef.current) return
    const player = getPlayer()
    const rect = player.getMediaRect()
    if (!rect) return
    captureInFlightRef.current = true
    try {
      const t = await player.getCurrentTime()
      // getBoundingClientRect is in CSS px, but the main process's capturePage
      // expects DIP, and on fractional-scaled desktops window.devicePixelRatio
      // (CSS→physical) diverges from the OS scaleFactor screen reports (dpr=1.31
      // while scaleFactor=1 → capturePage grabbed only the top-left slice, #?).
      // Send PHYSICAL px (CSS × dpr); main divides by scaleFactor → DIP. When
      // dpr == scaleFactor (normal/retina) this is identity (CSS px, as before).
      const dpr = window.devicePixelRatio || 1
      const res = await api.youtube.capture(
        { x: rect.x * dpr, y: rect.y * dpr, width: rect.width * dpr, height: rect.height * dpr },
        videoId,
        t,
      )
      // B-2: synthesize the Attachment from the capture result + known fields —
      // youtube.capture returns PersistCaptureResult, NOT an Attachment, and
      // there is no attachments.get read IPC. overlay_path starts null (set by
      // the editor's Done if drawn).
      // M5: `created_at` here is the renderer clock at capture time and DRIFTS from
      // the DB row's created_at (set in persistCapture). It exists only to satisfy
      // the Attachment shape for the chip/editor render; do NOT treat it as the
      // authoritative row timestamp — re-read from the DB if that's ever needed.
      const attachment: Attachment = {
        id: res.id,
        note_id: null,
        kind: 'screenshot',
        base_sha256: res.sha256,
        base_path: res.path,
        overlay_path: null,
        video_id: videoId,
        time_seconds: t,
        width_px: res.width,
        height_px: res.height,
        device_pixel_ratio: res.devicePixelRatio,
        created_at: Date.now(),
        deleted_at: null,
      }
      // Open the editor on the new frame (replaces any prior pending chip on Done).
      setCaptureFrame({ attachment, t })
    } catch (err) {
      console.error('frame capture failed', err)
    } finally {
      captureInFlightRef.current = false
    }
  }
  useHotkeys('mod+shift+c', () => {
    void onCapture()
  })

  // The editor reports the freshly-written overlay_path via onSaved (just before
  // onClose(true)); stash it so onClose can synthesize the chip's Attachment with
  // the new sidecar (B-2). A ref because onSaved fires synchronously before close.
  const savedOverlayPathRef = useRef<string | null>(null)

  // Capture editor finished. Done(saved) → set the pending chip to the (possibly
  // annotated) frame so the chip's AnnotatedFrame shows the drawing. Cancel /
  // Discard / empty-Keep → no chip.
  const onCaptureEditorClose = useCallback(
    (saved: boolean) => {
      const frame = captureFrame
      const overlayPath = savedOverlayPathRef.current
      savedOverlayPathRef.current = null
      setCaptureFrame(null)
      if (saved && frame) {
        setPendingFrame({
          attachment: { ...frame.attachment, overlay_path: overlayPath },
          t: frame.t,
        })
      }
    },
    [captureFrame],
  )

  // Esc → Discard on the capture editor: soft-delete the orphan row + sidecar.
  const onCaptureDiscard = useCallback(() => {
    const frame = captureFrame
    if (frame) void api.attachments.remove(frame.attachment.id)
  }, [captureFrame])

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
      if (frame) await api.attachments.attachToNote(frame.attachment.id, created.id)
      return created
    },
    onSuccess: () => {
      setPendingFrame(null)
      setPostError(null)
      void queryClient.invalidateQueries({ queryKey: ['notes'] })
      void queryClient.invalidateQueries({ queryKey: ['thread', noteId] })
      // ⌘O switcher feed + recent empty-state (spec §3: invalidate on create). The
      // ['note-recent'] prefix matches both recencyMode variants.
      void queryClient.invalidateQueries({ queryKey: ['note-titles'] })
      void queryClient.invalidateQueries({ queryKey: ['note-recent'] })
    },
    // Surface failures (duplicate slug, empty-body gate, etc.) inline in the
    // composer instead of failing silently — same contract as the feed.
    onError: (err: Error) => setPostError(err.message),
  })

  // ── generic thread: wikilink handler + plain/pdf post ────────────────────

  /**
   * Stable wikilink handler forwarded to both `ThreadRoot` and `NoteBubble`
   * children in the generic (plain/pdf) branch. Delegates to the app-level
   * resolver prop; no-ops when the prop is absent (e.g. in tests without a
   * navigator). Same pattern as the feed's `onWikilinkClick` delegation.
   *
   * Why useCallback with [onWikilinkClick]: the prop identity is stable
   * across renders when App.tsx passes a stable function; useCallback avoids
   * re-rendering every child bubble when unrelated ThreadView state changes.
   *
   * @see src/renderer/src/lib/markdown.tsx (onWikilinkClick signature)
   */
  const handleWikilink = useCallback(
    (slug: string) => {
      onWikilinkClick?.(slug)
    },
    [onWikilinkClick],
  )

  /**
   * Post a plain comment-note as a child of this thread (plain/pdf branch).
   * No media anchor — pure text, comment-on the root note's slug.
   * Invalidates the same keys as the youtube post so the child list re-renders.
   *
   * Why useCallback (not useMutation): the plain branch needs no loading/error
   * surface in the composer — SimpleComposer is intentionally minimal. A
   * useCallback keeps the wiring thin; error handling can be layered in v0.7+.
   *
   * @see src/renderer/src/lib/api.ts (notes.create signature)
   * @see src/renderer/src/thread/useThreadNotes.ts (queryKey: ['thread', noteId])
   */
  const postPlain = useCallback(
    async (body: string) => {
      if (!note?.slug) return
      await api.notes.create(body, 'claim', { commentOn: note.slug })
      void queryClient.invalidateQueries({ queryKey: ['thread', noteId] })
      void queryClient.invalidateQueries({ queryKey: ['notes'] })
      void queryClient.invalidateQueries({ queryKey: ['note-titles'] })
      void queryClient.invalidateQueries({ queryKey: ['note-recent'] })
    },
    [note, noteId, queryClient],
  )

  // ── generic (plain/pdf) thread scroll restore/persist (v0.7 · Task 2.2) ──────
  // ONLY the generic branch wires these. YouTube's `notesPane` owns scroll via the
  // always-on playhead-follow, so restoring/persisting there fights the follow — it
  // is excluded structurally: `genericScrollerRef` is never bound in the youtube
  // layout, so both the restore effect and the persist listener no-op for youtube.
  const genericScrollerRef = useRef<HTMLDivElement | null>(null)
  const scrollRestoredRef = useRef(false)
  // Snapshot the restore target ONCE at mount. ThreadView is keyed on threadNoteId, so
  // this instance is per-thread; the boot path seeds threadScrollMap BEFORE openThread
  // fires, making the mount-time `initialScrollTop` authoritative. Deliberately NOT
  // reactive to later prop changes: `initialScrollTop` flows back from the user's OWN
  // scroll (onScroll → App threadScrollMap → back down as this prop), so reacting to it
  // would yank an in-progress scroll to a stale offset on the first sustained scroll of a
  // no-saved-offset thread ("echo stomp"). Do NOT add `initialScrollTop` to the deps.
  const restoreTargetRef = useRef(initialScrollTop)
  // Apply the restored scrollTop ONCE, in a layout effect keyed on the child count so
  // it fires AFTER the children mount and establish scrollHeight — setting it before
  // content exists clamps the browser to 0. `scrollRestoredRef` makes it a one-shot so
  // later renders never stomp the user's live scroll position.
  useLayoutEffect(() => {
    if (scrollRestoredRef.current) return
    const target = restoreTargetRef.current
    if (target == null) {
      scrollRestoredRef.current = true
      return
    }
    const el = genericScrollerRef.current
    if (!el) return
    // Wait for children to establish scrollHeight before restoring a non-zero offset.
    if (target > 0 && sorted.length === 0) return
    el.scrollTop = target
    scrollRestoredRef.current = true
  }, [sorted.length])

  // Trailing-throttled scrollTop report → App persists the whole per-root map. One
  // timer per window; the trailing read pulls the LATEST scrollTop off the element.
  const scrollPersistTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const onGenericScroll = useCallback(() => {
    if (!onScroll || scrollPersistTimer.current) return
    scrollPersistTimer.current = setTimeout(() => {
      scrollPersistTimer.current = undefined
      const el = genericScrollerRef.current
      if (el) onScroll(el.scrollTop)
    }, SCROLL_PERSIST_THROTTLE_MS)
  }, [onScroll])
  // Clear a pending throttle timer on unmount (thread close / navigation).
  useEffect(() => () => clearTimeout(scrollPersistTimer.current), [])

  // ── render ────────────────────────────────────────────────────────────────

  // Whether this thread has any comment-on children. Drives the generic
  // (plain/pdf) branch's dividers: an empty thread suppresses the ThreadRoot
  // header rule + the composer's top rule so it reads clean (Task 3).
  const hasChildren = sorted.length > 0

  // Sort row + scrollable notes + composer (all layouts; player is in the dock).
  const notesPane = (
    <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <div
        // overflow:hidden CONTAINS the feed: the video-rail gutter (negative-offset
        // timestamps/dots) and the active-note box-shadow rings draw outside the inner
        // scroller, and without this they spilled left over the divider line and down
        // over the composer's top border (worst in the narrow split pane). The inner
        // scroller still owns the actual scrolling; this only clips the overflow.
        style={{ flex: 1, minHeight: 0, position: 'relative', overflow: 'hidden' }}
        onPointerEnter={thumb.onAreaEnter}
        onPointerLeave={thumb.onAreaLeave}
        onPointerMove={thumb.onAreaPointerMove}
      >
        <div
          ref={setScroller}
          data-testid="thread-scroll"
          onScroll={onNotesScroll}
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
              onReopenAttachment={setReopenAttachment}
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

        {/* Floating sort pill — overlays the notes' top-right (no dedicated row, so
            the notes reclaim that vertical space; the feed scrolls under it). */}
        <div
          style={{
            position: 'absolute',
            top: 8,
            left: 0,
            right: 0,
            display: 'flex',
            justifyContent: 'center',
            pointerEvents: 'none',
          }}
        >
          <div
            style={{
              width: '100%',
              maxWidth: COL,
              boxSizing: 'border-box',
              padding: '0 24px',
              display: 'flex',
              justifyContent: 'flex-end',
            }}
          >
            <div style={{ pointerEvents: 'auto' }}>
              <SortPill
                sortMode={sortMode}
                onToggle={() => setSortMode((m) => (m === 'video' ? 'capture' : 'video'))}
              />
            </div>
          </div>
        </div>

        {/* Floating date pill (capture view only) — names the topmost visible day. */}
        {sortMode === 'capture' && datePill && (
          <ScrollDatePill label={datePill} push={0} visible={datePillVisible} />
        )}

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
            initialDraft={initialDraft}
            onDraftChange={onDraftChange}
            onDraftClear={onDraftClear}
            pendingFrame={pendingFrame}
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
          // Match the dock pane header height token so the thread header's bottom
          // border lands on the SAME y as the right-dock pane header's border
          // (Task 6 — both were misaligned at 46px vs --topbar-h 44px).
          // @see src/renderer/src/panes/Dock.tsx (pane header: height var(--topbar-h))
          height: 'var(--topbar-h)',
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
        </div>
      </header>

      {kind === 'youtube' ? (
        // ── YouTube: Rail + sort pill + ThreadComposer (B5: player is in the
        // right-dock PlayerPane, opened by the effect above). The center stage
        // shows notes only; the fixed-overlay webview stays alive in the dock
        // even when the user switches to the feed or canvas view. ADR 0016.
        notesPane
      ) : (
        // ── Generic: ThreadRoot header + chronological NoteBubble list + SimpleComposer
        // Used for plain notes and PDF notes.  PDF's docked reader is the
        // media; the thread is chronological-only — same layout as plain.
        // `handleWikilink` forwards to the app-level resolver so wikilinks in
        // the root header and every child card navigate correctly (spec §"Wikilink
        // navigation in thread cards"). @see docs/plans/v0.6.4-notes-as-threads.md §Task 2.3
        //
        // Layout: a flex column so the scrollable content region (root + children)
        // takes the free space and the composer stays PINNED to the bottom of the
        // pane instead of flowing under short content (Task 4 — was top-aligned
        // with dead space below). An EMPTY thread (no children) suppresses both
        // the ThreadRoot header rule and the composer's top rule (Task 3).
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <div
            ref={genericScrollerRef}
            data-testid="thread-generic-scroll"
            onScroll={onGenericScroll}
            style={{
              flex: 1,
              minHeight: 0,
              overflowY: 'auto',
              padding: '12px 24px 20px',
            }}
          >
            <div style={{ maxWidth: COL, margin: '0 auto' }}>
              {note && (
                <ThreadRoot note={note} divider={hasChildren} onWikilinkClick={handleWikilink} />
              )}
              {/* flex column + gap gives consistent vertical spacing between child
                  bubbles (Task 2 — they were flush: NoteBubble carries no outer
                  margin, so borders touched). 12px matches the feed's 6+6 row
                  rhythm. `marginTop` only when there are children to separate from
                  the root. */}
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 'var(--space-4)',
                  marginTop: hasChildren ? 8 : 0,
                }}
              >
                {sorted.map((item) => (
                  <NoteBubble
                    key={item.id}
                    note={item.note}
                    focused={false}
                    expanded={true}
                    onToggleExpand={() => {}}
                    onFocus={() => {}}
                    onWikilinkClick={handleWikilink}
                    onEdit={() => {}}
                    onDelete={() => {}}
                    onCopyLink={() => {}}
                  />
                ))}
              </div>
            </div>
          </div>
          <div
            data-testid="thread-composer-region"
            style={{
              flex: '0 0 auto',
              // Divider only when there are children — an empty thread reads clean.
              ...(hasChildren ? { borderTop: '1px solid var(--border-0)' } : {}),
              padding: '10px 24px 12px',
              background: 'var(--bg-0)',
            }}
          >
            <div style={{ maxWidth: COL, margin: '0 auto' }}>
              <SimpleComposer
                onSubmit={postPlain}
                initialDraft={initialDraft}
                onDraftChange={onDraftChange}
                onDraftClear={onDraftClear}
              />
            </div>
          </div>
        </div>
      )}

      {/* Reopen-a-posted-screenshot editor (T4.2). ReopenEditor fetches the
          saved scene then mounts AnnotateEditor; Done invalidates the commentsOf
          query so the Rail re-reads the new overlay_path (B-4). */}
      {reopenAttachment && (
        <ReopenEditor
          attachment={reopenAttachment}
          noteId={noteId}
          onClose={() => setReopenAttachment(null)}
        />
      )}

      {/* Capture-time editor (T4.3): opens on ⌘⇧C's freshly-captured orphan
          frame. escMode='orphan' → Esc shows discard/keep-orphan. Done → pending
          chip; onSaved stashes the new overlay_path so the chip renders the
          drawing. onDiscardOrphan soft-deletes the orphan + sidecar. */}
      {captureFrame && (
        <AnnotateEditor
          attachment={captureFrame.attachment}
          initialScene={null}
          escMode="orphan"
          onSaved={(overlayPath) => {
            savedOverlayPathRef.current = overlayPath
          }}
          onDiscardOrphan={onCaptureDiscard}
          onClose={onCaptureEditorClose}
        />
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
    <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
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
