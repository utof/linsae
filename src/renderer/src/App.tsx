import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AnimatePresence, motion, type Transition, useReducedMotion } from 'motion/react'
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useHotkeys } from 'react-hotkeys-hook'
import { MANUAL_ARRANGEMENT_ID, ROOT_CANVAS_ID } from '../../shared/canvas'
import type { Note, NoteType } from '../../shared/types'
import { BacklinksPane } from './backlinks/BacklinksPane'
import { CanvasStage } from './canvas/CanvasStage'
import { RecentPopover } from './canvas/RecentPopover'
import { StatusBar } from './canvas/StatusBar'
import { Composer } from './composer/Composer'
import { setOverlay, toggleOverlay, useDevOverlay } from './dev/devOverlays'
import { Feed } from './feed/Feed'
import { api } from './lib/api'
import { noteTitle } from './lib/note-title'
import { parseYouTubeUrl } from './lib/parse-youtube-url'
import { CommandPalette } from './palette/CommandPalette'
import { Dock } from './panes/Dock'
import { ShelfContext } from './panes/ShelfPane'
import { SettingsPanel } from './settings/SettingsPanel'
import { ThreadView } from './thread/ThreadView'
import { WindowFrame } from './topbar/WindowFrame'

// Reveal-animation playground (mod+shift+R) — a dev tool. Enabled in `pnpm dev`, and in
// a build via `VITE_PLAYGROUND=1 electron-vite build` (so it can be harness-driven); a
// normal production build tree-shakes it out (both flags statically false).
// @see src/renderer/src/dev/RevealPlayground.tsx
const DEV_PLAYGROUND = import.meta.env.DEV || !!import.meta.env.VITE_PLAYGROUND
const RevealPlayground = DEV_PLAYGROUND
  ? lazy(() => import('./dev/RevealPlayground').then((m) => ({ default: m.RevealPlayground })))
  : null
// Always-visible dev panel (`pnpm dev` only) to tune the wave entrance live on the real feed.
// Gated on import.meta.env.DEV → tree-shaken from production AND the VITE_PLAYGROUND harness
// build (so it can't overlay the harness's measurements). @see src/renderer/src/dev/WaveTuner.tsx
const WaveTuner = import.meta.env.DEV
  ? lazy(() => import('./dev/WaveTuner').then((m) => ({ default: m.WaveTuner })))
  : null

/**
 * Root shell for v0.1 — composes Topbar, Feed, Composer, BacklinksPane, and
 * CommandPalette around the rolling-feed query/mutation surface.
 *
 * Why a dual resolver for wikilinks: render-pass dangling styling needs a
 * synchronous answer for every `[[slug]]` in the markdown, so we build a
 * `slugSet` from the cached notes list and pass `resolveSlug` down to
 * `Feed` → `NoteBubble` → `Markdown`. Click navigation, however, must honour
 * the alias + most-recent-wins rule (spec §Resolution rule) which lives in
 * SQLite — so `onWikilinkClick` round-trips through `api.links.resolve`.
 *
 * Why draft-body pattern (vs auto-creating a note on dangling click): the
 * spec §Wikilinks step 4 says the click "opens the composer pre-filled with
 * a new note whose first line is `target`". We prefill `draftBody` and let
 * the user hit Enter to commit — no DB/file writes happen until then, so the
 * user can edit the title or back out cleanly. The `key={draftBody ?? 'fresh'}`
 * on the create-mode Composer forces a remount so the new `initialBody` is
 * picked up by the textarea's `useState(initialBody)` initialiser.
 *
 * Why react-hotkeys-hook for `⌘K` + `Esc` (not the composer's local handler):
 * these shortcuts must fire from outside the composer too (e.g. when the
 * focused-bubble has focus). The composer's local Esc handler calls
 * `e.stopPropagation()` only when it owns the precedence step (question mode
 * or edit mode) — so the global hook resolves the spec's remaining steps
 * (palette / focused pane). `?` stays composer-local per spec §Implementation
 * note to avoid the shifted-key gotcha.
 *
 * Why the reconcile-skip banner trigger reads via IPC: main collects the
 * skip count at startup and the renderer fetches it via
 * `system:getReconcileSkipped`. `staleTime: Number.POSITIVE_INFINITY` because
 * the count is set once at process boot and never mutates during a session
 * (CLAUDE.md §Stack — biome's `useNumberNamespace` forbids the raw `Infinity`).
 *
 * @see docs/specs/v0.1-rolling-feed-and-search.md §Esc precedence
 * @see docs/specs/v0.1-rolling-feed-and-search.md §Wikilinks
 * @see docs/plans/v0.1-rolling-feed-and-search.md §Task 30
 */
export function App() {
  const queryClient = useQueryClient()
  const { data: notes = [], isPending: notesPending } = useQuery({
    queryKey: ['notes'],
    // limit defaults to 500 (the Zod max) — the NEWEST 500 notes, oldest-first
    // (listNotes). A new note is always in this page; older notes beyond 500 wait
    // on scroll-back pagination (issue #20). The plan literal said 5000 but the
    // schema caps at 500.
    queryFn: () => api.notes.list(),
  })
  const [focusedId, setFocusedId] = useState<string | null>(null)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null)
  // Dev-overlay state — MUST be called unconditionally (rules of hooks); the store
  // is inert in prod but the hooks must not be gated on import.meta.env.DEV.
  // @see src/renderer/src/dev/devOverlays.ts module doc
  const waveOn = useDevOverlay('wave')
  const revealOpen = useDevOverlay('reveal')
  const [draftBody, setDraftBody] = useState<string | null>(null)
  // viewMode toggles the non-thread <main> between the rolling feed+composer and
  // the canvas stage. The feed↔canvas swap animates via the §6 stage slide
  // (AnimatePresence below) — only the two outer stage containers' x-transform
  // moves; the feed's virtualized rows are untouched (ADR 0019 guardrail).
  // BacklinksPane stays outside both, working over either view.
  const [viewMode, setViewMode] = useState<'feed' | 'canvas'>('feed')
  // One-shot placement state (spec §6): set by the feed's "place on canvas…"
  // verb; CanvasStage consumes it to show the ghost + banner, then calls
  // onPlacingDone on commit/cancel. Carries the title for the banner copy.
  const [placing, setPlacing] = useState<{ noteId: string; title: string } | null>(null)
  // Left dock (shelf) open state — in-memory view-state, not persisted (§10).
  const [dockOpen, setDockOpen] = useState(false)
  // Recent-popover open state lives in App so the status-bar trigger and (Task
  // 11) ⌘J can both toggle it; rendered above the status bar (spec §14).
  const [recentOpen, setRecentOpen] = useState(false)
  // Status-bar zoom readout (%). CanvasStage reports its live zoom UP via
  // onCameraChange (the camera itself never leaves CanvasStage — Task 10 seam).
  const [zoomPct, setZoomPct] = useState(100)
  // Camera-seam DOWN signals: bumping these numbers asks CanvasStage to run
  // fit / 100%-reset on its OWN camera (status-bar `fit` / `1:1` buttons).
  const [fitSignal, setFitSignal] = useState(0)
  const [resetSignal, setResetSignal] = useState(0)
  // jump-to-card request: a {id, nonce} App sets when a feed/recent/shelf row
  // asks to jump. CanvasStage watches it (the camera lives there) and pans +
  // ring-flashes. The nonce lets a repeat jump to the SAME card re-fire.
  const [jumpTo, setJumpTo] = useState<{ id: string; nonce: number } | null>(null)
  const [skipBannerDismissed, setSkipBannerDismissed] = useState(false)
  // threadNoteId: when non-null, the full-screen ThreadView replaces the feed+composer.
  // Mutual exclusivity: opening a thread clears focusedId so BacklinksPane doesn't
  // linger behind ThreadView; the key={threadNoteId} on ThreadView forces a remount on
  // each navigation so the player singleton and duration write-back state reset per video.
  const [threadNoteId, setThreadNoteId] = useState<string | null>(null)
  // submitError surfaces a user-facing message from the last failed
  // create/update mutation (e.g. duplicate-slug). The Composer renders it
  // inline; the next keystroke clears it via onClearError. See issue #23.
  const [submitError, setSubmitError] = useState<string | null>(null)
  // successCount ticks on every successful create. Used in the create-mode
  // Composer's `key` so a successful submit forces a remount → fresh
  // `initialBody=''`. We can't clear body inside the Composer itself
  // because the mutation is async — clearing pre-emptively would wipe the
  // user's text on failure (which is the entire point of the Option B
  // body-preservation contract).
  const [successCount, setSuccessCount] = useState(0)

  // Send-in-progress flag: true from the moment the user submits a new note until
  // shortly after it has glided into place. The Feed reads it to suppress the
  // virtualizer's own auto-scroll (`anchorTo:'end'` / `followOnAppend`) during the
  // window where the make-room scroll-glide (`useGlideReveal`) owns the scroll —
  // without it, the new row's first measure rides the scroll up and rapid sends
  // desync the rendered range (the #66 white wall). The note simply rises into view
  // via the glide; there is no flying ghost (ADR 0020 supersedes ADR 0018).
  const feedScrollerRef = useRef<HTMLDivElement | null>(null)
  const [sendInFlight, setSendInFlight] = useState(false)
  const sendingTimerRef = useRef<number | undefined>(undefined)
  // Records notes.length at the moment of submit so the append-coupled effect
  // can detect when the new note has landed (notes.length > pendingFromLen).
  const pendingFromLenRef = useRef<number | null>(null)
  useEffect(
    () => () => {
      if (sendingTimerRef.current !== undefined) clearTimeout(sendingTimerRef.current)
    },
    [],
  )
  const beginSend = () => {
    setSendInFlight(true)
    pendingFromLenRef.current = notes.length
    if (sendingTimerRef.current !== undefined) clearTimeout(sendingTimerRef.current)
    // Fail-safe only: the append-coupled effect (below) clears sendInFlight the moment
    // the new note lands. This timeout is a backstop for the rare case where the
    // refetch never grows the list (e.g. a background delete raced the create). Scales
    // with the dev slow-mo so debugging at `__morphSlow` keeps the suppression on.
    const ms = import.meta.env.DEV ? 4000 * (window.__morphSlow ?? 1) : 4000
    sendingTimerRef.current = window.setTimeout(() => setSendInFlight(false), ms)
  }
  // Append-coupled clear: the moment the new note lands, hand off to the Feed's own
  // revealing/waveSettling (which carry suppression through the settle).
  // Why: createMut is non-optimistic (onSuccess → invalidate → refetch), so the append
  // render can arrive after an unbounded round-trip; a wave needs `suppressFollow` TRUE
  // on that render or virtual-core's reconcileScroll re-arms.
  // @see docs/specs/v0.2.2-repulsion-wave.md §Guard
  useEffect(() => {
    const from = pendingFromLenRef.current
    if (from !== null && notes.length > from) {
      pendingFromLenRef.current = null
      if (sendingTimerRef.current !== undefined) clearTimeout(sendingTimerRef.current)
      setSendInFlight(false)
    }
  }, [notes.length])

  // Clear submitError whenever the composer's context changes (user clicks
  // edit on a different note, opens a dangling-wikilink draft, etc.). Without
  // this, an unrelated create error from a previous attempt would briefly
  // render in the new edit-mode composer until the first keystroke.
  // biome-ignore lint/correctness/useExhaustiveDependencies: setSubmitError is stable
  useEffect(() => {
    setSubmitError(null)
  }, [editingNoteId, draftBody])

  // Remove the static boot splash (index.html #boot-splash) once the notes
  // query has settled. The splash paints on the first frame — before the JS
  // module graph mounts — so the window appears immediately instead of after
  // React is ready; keeping it until `notesPending` flips false also covers the
  // post-mount notes-IPC gap, so the feed crossfades straight in with no
  // "nothing yet" flash. The splash lives outside React's #root (createRoot
  // never touches it), so we remove it imperatively. This effect runs after the
  // commit that rendered the feed has painted, so we reveal a painted feed.
  useEffect(() => {
    if (notesPending) return
    const splash = document.getElementById('boot-splash')
    if (!splash) return
    splash.classList.add('boot-splash--hide')
    const t = window.setTimeout(() => splash.remove(), 360)
    return () => window.clearTimeout(t)
  }, [notesPending])

  // Synchronous slug-only resolver for the Markdown component's dangling
  // class pass. The full alias-aware resolver runs only on click (below).
  const slugSet = useMemo(
    () => new Set(notes.filter((n) => !n.deleted_at).map((n) => n.slug)),
    [notes],
  )
  const resolveSlug = (slug: string) => slugSet.has(slug.toLowerCase().trim())

  // Widen the pinned-data refetch (spec §3): saves must converge feed↔canvas,
  // and link edits must redraw canvas edges. Invalidates the feed list, every
  // single-note query, and the resolved-edge query.
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['notes'] })
    void queryClient.invalidateQueries({ queryKey: ['note'] }) // every ['note', id]
    void queryClient.invalidateQueries({ queryKey: ['canvas-edges'] })
  }

  /**
   * Paste interceptor for the create-mode composer. Called with the raw
   * clipboard text; returns true (handled) if the text contains a YouTube URL
   * so the Composer prevents the default textarea insertion.
   *
   * Flow: create source note immediately (feeds the card into the list),
   * then fetch oEmbed metadata and upsert the video_sources row. The oEmbed
   * step is fail-soft — if fetchOEmbed returns null the note still exists and
   * the card shows the raw video id as its title.
   *
   * Why the oEmbed + upsert are awaited sequentially (not parallel): upsert
   * depends on the oEmbed result, so they must be ordered. The create is
   * awaited first so the feed card appears immediately.
   *
   * @see docs/specs/v0.2-youtube-annotation.md §Add a video
   */
  const handlePasteText = (text: string): boolean => {
    const videoId = parseYouTubeUrl(text)
    if (!videoId) return false
    void (async () => {
      try {
        await api.notes.create('', 'source', {
          source_kind: 'youtube',
          source_locator: { media: 'youtube', video_id: videoId },
        })
        // Tick successCount so the create-mode Composer remounts clean (clears
        // question mode) exactly as createMut.onSuccess does. Runs on create
        // success before the fail-soft oEmbed step. Why: a failed create must
        // surface the error (see catch below); a succeeded create must reset
        // the composer regardless of whether oEmbed succeeds.
        setSuccessCount((c) => c + 1)
        void queryClient.invalidateQueries({ queryKey: ['notes'] })
        // oEmbed + upsert are fail-soft: if either rejects the note still exists
        // and the card shows the raw video id as its title.
        const o = await api.youtube.fetchOEmbed(videoId)
        if (o) {
          await api.videoSources.upsert(videoId, {
            title: o.title,
            channel: o.author_name,
            thumbnailUrl: o.thumbnail_url,
          })
          void queryClient.invalidateQueries({ queryKey: ['videoSource', videoId] })
        }
      } catch (err) {
        // Surface create failures the same way createMut.onError does so the
        // user knows the paste failed and their text is already gone
        // (preventDefault was called before this async block started). The
        // oEmbed/upsert portion is intentionally outside the catch — it is
        // fail-soft and must not change the error state on its own.
        setSubmitError(err instanceof Error ? err.message : String(err))
      }
    })()
    return true
  }

  const createMut = useMutation({
    mutationFn: ({ body, type }: { body: string; type: NoteType }) => api.notes.create(body, type),
    onSuccess: () => {
      invalidate()
      setDraftBody(null)
      setSubmitError(null)
      setSuccessCount((c) => c + 1)
    },
    onError: (err: Error) => setSubmitError(err.message),
  })
  const updateMut = useMutation({
    mutationFn: ({ id, body, type }: { id: string; body: string; type: NoteType }) =>
      api.notes.update(id, body, type),
    onSuccess: () => {
      invalidate()
      setEditingNoteId(null)
      // Also clear any lingering dangling-link draft so the create-mode composer
      // doesn't reappear with the previous prefill after an unrelated edit.
      setDraftBody(null)
      setSubmitError(null)
    },
    onError: (err: Error) => setSubmitError(err.message),
  })
  const deleteMut = useMutation({
    mutationFn: (id: string) => api.notes.delete(id),
    onSuccess: invalidate,
  })

  // `enableOnFormTags` lets the global hook fire from inside the composer's
  // textarea. The composer's local Esc handler calls stopPropagation when it
  // owns the event (question/edit modes), so this only fires for steps 1-2
  // of the Esc precedence ladder (palette → focused pane).
  useHotkeys(
    'mod+k',
    (e) => {
      e.preventDefault()
      setPaletteOpen((o) => !o)
    },
    { enableOnFormTags: ['textarea', 'input'] },
  )
  // View toggle: mod+1 → feed, mod+2 → canvas (spec §6). Fires from inside the
  // composer too (enableOnFormTags) so the user can switch without leaving text.
  useHotkeys(
    'mod+1',
    (e) => {
      e.preventDefault()
      setViewMode('feed')
    },
    { enableOnFormTags: ['textarea', 'input'] },
  )
  useHotkeys(
    'mod+2',
    (e) => {
      e.preventDefault()
      setViewMode('canvas')
    },
    { enableOnFormTags: ['textarea', 'input'] },
  )
  // ⌘J → recent-popover toggle (spec §15). Lives in App because `recentOpen` +
  // the <RecentPopover> mount are App-level chrome (the status-bar trigger shares
  // the same state). Gated `enabled: viewMode==='canvas'` so it is inert in the
  // feed view — the popover is a canvas affordance (spec §14). `enableOnFormTags`
  // off so it never fires while typing in the composer.
  useHotkeys(
    'mod+j',
    (e) => {
      e.preventDefault()
      setRecentOpen((o) => !o)
    },
    { enabled: viewMode === 'canvas' },
    [viewMode],
  )
  // App's global esc ladder (settings → palette → focused pane). Each rung guards
  // on its OWN state boolean, so this is a no-op when none of App's overlays are
  // open. This is a BUBBLE-phase document listener (react-hotkeys-hook's default).
  // The canvas esc cascade (CanvasStage) is a CAPTURE-phase listener on the canvas
  // viewport node: an esc dispatched inside the canvas is seen by the viewport
  // capture handler DURING the capture descent — before the event can bubble up to
  // this document listener — and that handler calls stopPropagation when it
  // consumes, so the event never reaches here. Precedence is thus by event-phase +
  // tree position (deterministic), NOT react-hotkeys-hook registration order
  // (which is undefined between two instances). @see CanvasStage.tsx esc cascade,
  // issue #18 (esc precedence audit).
  useHotkeys(
    'esc',
    () => {
      if (settingsOpen) {
        setSettingsOpen(false)
        return
      }
      if (paletteOpen) {
        setPaletteOpen(false)
        return
      }
      if (focusedId) {
        setFocusedId(null)
      }
    },
    { enableOnFormTags: ['textarea', 'input'] },
    [settingsOpen, paletteOpen, focusedId],
  )
  // DEV: toggle the reveal-animation playground (mod+shift+R).
  useHotkeys(
    'mod+shift+r',
    (e) => {
      e.preventDefault()
      toggleOverlay('reveal')
    },
    { enabled: DEV_PLAYGROUND, enableOnFormTags: ['textarea', 'input'] },
  )

  /**
   * Opens the ThreadView for a source note, clearing focusedId so the
   * BacklinksPane doesn't linger while the thread is open, and clearing
   * editingNoteId so a stale edit-mode Composer cannot reappear when the
   * thread is later closed.
   * Mutual exclusivity: when threadNoteId is non-null, the feed+composer
   * branch is not rendered (see JSX below).
   */
  const openThread = (id: string) => {
    void api.notes.recordAccess(id, 'open')
    setFocusedId(null)
    setEditingNoteId(null)
    setThreadNoteId(id)
  }

  const onWikilinkClick = async (slug: string) => {
    const match = await api.links.resolve(slug)
    if (match) {
      setFocusedId(match.id)
      return
    }
    // Dangling: prefill the composer with `# <slug>\n\n` (spec §Wikilinks
    // step 4) — do NOT auto-create. The user must hit Enter to commit.
    setDraftBody(`# ${slug}\n\n`)
  }

  const editingNote: Note | undefined = editingNoteId
    ? notes.find((n) => n.id === editingNoteId)
    : undefined

  const { data: skipped = 0 } = useQuery({
    queryKey: ['reconcile-skipped'],
    queryFn: () => api.system.getReconcileSkipped(),
    staleTime: Number.POSITIVE_INFINITY,
  })

  // Canvas placement state (spec §9/§14). The SAME query key CanvasStage +
  // ShelfPane read, so react-query dedups — one IPC round-trip serves all three.
  // `placedNoteIds` drives the feed bubbles' ▦ traces; `unplacedCount` drives
  // the status-bar `N unplaced ●` indicator.
  const { data: layoutRows = [] } = useQuery({
    queryKey: ['canvas-layouts', ROOT_CANVAS_ID],
    queryFn: () =>
      api.canvas.listLayouts({ canvasId: ROOT_CANVAS_ID, arrangementId: MANUAL_ARRANGEMENT_ID }),
  })
  // Use the SAME `x !== null && y !== null` placed-test as CanvasStage's
  // placedLayouts so the two can never textually disagree (the §1 CHECK
  // constraint — x/y are null together — makes the y-test redundant but kept for
  // parity). unplacedCount counts the shelved rows (NULL x/y).
  const placedNoteIds = useMemo(
    () => new Set(layoutRows.filter((r) => r.x !== null && r.y !== null).map((r) => r.note_id)),
    [layoutRows],
  )
  const unplacedCount = useMemo(() => layoutRows.filter((r) => r.x === null).length, [layoutRows])

  // ---- Feed↔canvas placement verbs (spec §6/§9, threaded into <Feed>). Each is
  // bound to the note id inside NoteBubble (ADR 0006 stability); App only needs
  // them referentially stable enough not to thrash — they close over setState
  // setters (stable) + queryClient (stable) + the notes list for title lookup.
  const shelfMut = useMutation({
    mutationFn: (id: string) =>
      api.canvas.shelveNote({
        canvasId: ROOT_CANVAS_ID,
        arrangementId: MANUAL_ARRANGEMENT_ID,
        noteId: id,
      }),
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: ['canvas-layouts', ROOT_CANVAS_ID] }),
  })
  // → shelf: stay in the feed (no view switch); the status bar's unplaced
  // indicator updates once the layouts query invalidates. shelfMut is stable.
  const onShelf = useCallback((id: string) => shelfMut.mutate(id), [shelfMut])
  // place on canvas…: enter one-shot mode + switch to canvas (the slide animates
  // the switch). Title derived via noteTitle for the placement banner.
  const onPlaceOnCanvas = useCallback(
    (id: string) => {
      const note = notes.find((n) => n.id === id)
      setPlacing({ noteId: id, title: note ? noteTitle(note) : id })
      setViewMode('canvas')
    },
    [notes],
  )
  // jump-to-card: switch to canvas + ask CanvasStage to pan + ring-flash the
  // card. CanvasStage owns the camera, so App signals via a jump request (a
  // {id, nonce} bump) the stage consumes. Stable (only stable setters in scope).
  const onJumpToCard = useCallback((id: string) => {
    void api.notes.recordAccess(id, 'jump')
    setViewMode('canvas')
    setJumpTo((j) => ({ id, nonce: (j?.nonce ?? 0) + 1 }))
  }, [])
  // shelf row, unplaced, feed-direction (ShelfContext): scroll + flash the note
  // in the feed via the existing focus path. Stable (setFocusedId is a setter).
  const onGotoNote = useCallback((id: string) => setFocusedId(id), [])
  // begin a place-from-shelf ghost drag (canvas view only). The ghost/drop is
  // CanvasStage's interaction hook; App reuses the one-shot placing state.
  const onBeginShelfDrag = useCallback(
    (id: string) => {
      const note = notes.find((n) => n.id === id)
      setPlacing({ noteId: id, title: note ? noteTitle(note) : id })
    },
    [notes],
  )

  // Camera seam UP (M1): a STABLE handler for CanvasStage's onCameraChange so its
  // [camera.zoom, onCameraChange] effect doesn't re-run on every App render. The
  // prop documents a caller-stable contract; this honors it.
  const handleCameraChange = useCallback((zoom: number) => setZoomPct(Math.round(zoom * 100)), [])

  // ShelfContext value, memoized (M3) so shelf consumers don't re-render on every
  // App render. All four entries are now referentially stable (the callbacks are
  // useCallback-wrapped above; viewMode is the only changing dep).
  const shelfContextValue = useMemo(
    () => ({ view: viewMode, onGotoNote, onJumpToCard, onBeginShelfDrag }),
    [viewMode, onGotoNote, onJumpToCard, onBeginShelfDrag],
  )

  // ADR-0019 guardrail: every animation respects prefers-reduced-motion. A
  // zero-duration transition keeps the AnimatePresence swap semantics (mount/
  // unmount on view change) but removes the slide motion. @see adrs/0019-motion.md
  const reduceMotion = useReducedMotion()
  const slideTransition: Transition = reduceMotion
    ? { duration: 0 }
    : { duration: 0.22, ease: 'easeInOut' }

  return (
    // ShelfContext provides the shelf pane (rendered inside the Dock) its
    // navigation surface (spec §4). The dock is window chrome — it coexists with
    // both views and reads `view` to branch its row-click behaviour.
    <ShelfContext.Provider value={shelfContextValue}>
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          height: '100vh',
          overflow: 'hidden',
          background: 'var(--bg-0)',
        }}
      >
        <WindowFrame
          onOpenPalette={() => setPaletteOpen(true)}
          onOpenSettings={() => setSettingsOpen(true)}
          view={viewMode}
          onViewChange={setViewMode}
          dockOpen={dockOpen}
          onToggleDock={() => setDockOpen((o) => !o)}
        />
        {/* Body row: position:relative so BacklinksPane can absolutely overlay
         it without pushing the feed left when the pane opens (the previous
         flex-sibling layout shifted the entire feed; user feedback called
         that "annoying and too much for such a small action"). The pane
         covers the feed area only — WindowFrame stays visible above.
         When threadNoteId is non-null, ThreadView replaces the feed+composer
         and BacklinksPane entirely (they are mutually exclusive UI modes).
         key={threadNoteId} forces a remount when switching threads so the
         player singleton and duration write-back state reset per video. */}
        <div
          style={{
            display: 'flex',
            flex: 1,
            minHeight: 0,
            position: 'relative',
          }}
        >
          {threadNoteId ? (
            <ThreadView
              key={threadNoteId}
              noteId={threadNoteId}
              onClose={() => setThreadNoteId(null)}
            />
          ) : (
            <>
              {/* Dock (spec §10) — window chrome, sits LEFT of <main> and coexists
                with both views. Returns null when closed. */}
              <Dock open={dockOpen} paneId="shelf" onClose={() => setDockOpen(false)} />
              <main
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  flex: 1,
                  minWidth: 0,
                  minHeight: 0,
                }}
              >
                {skipped > 0 && !skipBannerDismissed && (
                  <div
                    style={{
                      padding: '8px 16px',
                      background: '#FDECEC',
                      borderBottom: '1px solid #FAEAC2',
                      fontSize: 13,
                      color: 'var(--fg-1)',
                      display: 'flex',
                      gap: 12,
                      alignItems: 'center',
                    }}
                  >
                    <span>{skipped} notes had unreadable frontmatter and were skipped.</span>
                    <button
                      type="button"
                      onClick={() => {
                        void api.system.openLogsFolder()
                      }}
                      style={{
                        border: 0,
                        background: 'transparent',
                        color: 'var(--accent)',
                        cursor: 'pointer',
                        textDecoration: 'underline',
                      }}
                    >
                      view log.
                    </button>
                    <div style={{ flex: 1 }} />
                    <button
                      type="button"
                      onClick={() => setSkipBannerDismissed(true)}
                      style={{
                        border: 0,
                        background: 'transparent',
                        cursor: 'pointer',
                        color: 'var(--fg-2)',
                      }}
                    >
                      dismiss
                    </button>
                  </div>
                )}
                {/* §6 stage slide: feed exits left / canvas enters right→left. Only
                  the two OUTER stage containers' x-transform animates — the feed's
                  virtualized rows are untouched (ADR 0019 guardrail: no
                  layout/layoutId projection inside the feed). `mode="wait"` keeps
                  exactly one stage mounted at a time (so the feed + canvas queries
                  don't both run), `initial={false}` skips the first-paint slide.
                  The two wrappers fill <main>'s flex area with overflow hidden so
                  the off-screen slide never shows a scrollbar. */}
                <AnimatePresence mode="wait" initial={false}>
                  {viewMode === 'canvas' ? (
                    <motion.div
                      key="canvas"
                      initial={{ x: '100%' }}
                      animate={{ x: 0 }}
                      exit={{ x: '-100%' }}
                      transition={slideTransition}
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        flex: 1,
                        minHeight: 0,
                        overflow: 'hidden',
                      }}
                    >
                      <CanvasStage
                        onWikilinkClick={onWikilinkClick}
                        resolveSlug={resolveSlug}
                        placing={placing}
                        onPlacingDone={() => setPlacing(null)}
                        onCameraChange={handleCameraChange}
                        fitSignal={fitSignal}
                        resetSignal={resetSignal}
                        jumpTo={jumpTo}
                      />
                    </motion.div>
                  ) : (
                    <motion.div
                      key="feed"
                      initial={{ x: '100%' }}
                      animate={{ x: 0 }}
                      exit={{ x: '-100%' }}
                      transition={slideTransition}
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        flex: 1,
                        minHeight: 0,
                        overflow: 'hidden',
                      }}
                    >
                      {notes.length === 0 ? (
                        <div
                          style={{
                            flex: 1,
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            color: 'var(--fg-3)',
                            fontFamily: 'var(--font-sans)',
                            fontSize: 14,
                          }}
                        >
                          nothing yet. start anywhere.
                        </div>
                      ) : (
                        <Feed
                          notes={notes}
                          scrollerRef={feedScrollerRef}
                          sendInFlight={sendInFlight}
                          focusedId={focusedId}
                          // Toggle behaviour: clicking an unfocused bubble focuses it (opens
                          // BacklinksPane); clicking the already-focused bubble unfocuses it
                          // (closes the pane). Wikilink / palette / pane-jump callbacks set
                          // focus directly without toggling — those are navigation gestures.
                          onFocus={(id) => setFocusedId((cur) => (cur === id ? null : id))}
                          onWikilinkClick={onWikilinkClick}
                          resolveSlug={resolveSlug}
                          onEdit={setEditingNoteId}
                          onDelete={(id) => {
                            deleteMut.mutate(id)
                            if (focusedId === id) setFocusedId(null)
                          }}
                          onCopyLink={(id) => {
                            void navigator.clipboard.writeText(`linsae://note/${id}`)
                          }}
                          onOpenThread={openThread}
                          // Canvas traces + verbs (spec §6/§9) — placedNoteIds drives the
                          // ▦ chip; the three callbacks are threaded to NoteBubble by id.
                          placedNoteIds={placedNoteIds}
                          onShelf={onShelf}
                          onPlaceOnCanvas={onPlaceOnCanvas}
                          onJumpToCard={onJumpToCard}
                        />
                      )}
                      {editingNote ? (
                        <Composer
                          key={editingNote.id}
                          initialBody={editingNote.body}
                          initialMode={editingNote.type}
                          editMode
                          error={submitError}
                          onClearError={() => setSubmitError(null)}
                          onSubmit={({ body, type }) =>
                            updateMut.mutate({ id: editingNote.id, body, type })
                          }
                          onCancel={() => setEditingNoteId(null)}
                        />
                      ) : (
                        // Composite key: `draftBody ?? 'fresh'` handles the dangling-wikilink
                        // prefill remount; `successCount` ticks on successful create to
                        // force a remount → fresh empty textarea. Failed creates leave the
                        // key unchanged so the user's text + cursor survive.
                        <Composer
                          key={`${draftBody ?? 'fresh'}-${successCount}`}
                          initialBody={draftBody ?? ''}
                          initialMode="claim"
                          error={submitError}
                          onClearError={() => setSubmitError(null)}
                          // Flag the send so the Feed suppresses its auto-scroll while the new
                          // note glides in (see `beginSend`), THEN create it.
                          onSubmit={({ body, type }) => {
                            beginSend()
                            createMut.mutate({ body, type })
                          }}
                          onCancel={() => setDraftBody(null)}
                          onPasteText={handlePasteText}
                        />
                      )}
                    </motion.div>
                  )}
                </AnimatePresence>
              </main>
              {focusedId && (
                <BacklinksPane
                  focusedNoteId={focusedId}
                  onClose={() => setFocusedId(null)}
                  onJump={setFocusedId}
                />
              )}
            </>
          )}
        </div>
        {/* App-wide footer (spec §14): the status strip plus the recent popover it
          anchors. position:relative so RecentPopover (position:absolute,
          bottom:100%) floats UP from the strip. Hidden during a thread so the
          full-screen ThreadView owns the chrome. */}
        {!threadNoteId && (
          <div style={{ position: 'relative', flexShrink: 0 }}>
            <RecentPopover
              open={recentOpen}
              onClose={() => setRecentOpen(false)}
              onJump={onJumpToCard}
            />
            <StatusBar
              view={viewMode}
              placedCount={placedNoteIds.size}
              unplacedCount={unplacedCount}
              zoomPct={zoomPct}
              onOpenShelf={() => setDockOpen(true)}
              onResetZoom={() => setResetSignal((s) => s + 1)}
              onFit={() => setFitSignal((s) => s + 1)}
              onToggleRecent={() => setRecentOpen((o) => !o)}
            />
          </div>
        )}
        <CommandPalette
          open={paletteOpen}
          onClose={() => setPaletteOpen(false)}
          onJump={setFocusedId}
        />
        <SettingsPanel open={settingsOpen} onClose={() => setSettingsOpen(false)} />
        {DEV_PLAYGROUND && revealOpen && RevealPlayground && (
          <Suspense fallback={null}>
            <RevealPlayground onClose={() => setOverlay('reveal', false)} />
          </Suspense>
        )}
        {WaveTuner && waveOn && (
          <Suspense fallback={null}>
            <WaveTuner />
          </Suspense>
        )}
      </div>
    </ShelfContext.Provider>
  )
}
