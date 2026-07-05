import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AnimatePresence, motion, type Transition, useReducedMotion } from 'motion/react'
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useHotkeys } from 'react-hotkeys-hook'
import { MANUAL_ARRANGEMENT_ID, ROOT_CANVAS_ID } from '../../shared/canvas'
import type { Note, NoteType } from '../../shared/types'
import { BacklinksContext } from './backlinks/BacklinksContext'
import { CanvasStage } from './canvas/CanvasStage'
import { PlacementGhost } from './canvas/PlacementGhost'
import { RecentPopover } from './canvas/RecentPopover'
import { StatusBar } from './canvas/StatusBar'
import { Composer } from './composer/Composer'
import { setOverlay, toggleOverlay, useDevOverlay } from './dev/devOverlays'
import { Feed } from './feed/Feed'
import { computeFeedBand } from './feed/feedBand'
import { api } from './lib/api'
import { noteTitle } from './lib/note-title'
import { parseYouTubeUrl } from './lib/parse-youtube-url'
import { CommandMenu } from './palette/CommandMenu'
import { ContentSearch } from './palette/ContentSearch'
import { type Command, useCommandStore } from './palette/command-store'
import { QuickSwitcher } from './palette/QuickSwitcher'
import { DockHost } from './panes/DockHost'
import { maxDockWidth, type PaneKind } from './panes/dock-widths'
import {
  dockKindFor,
  dockWidthFor,
  isSideShown,
  subscribeDockPersist,
  useDockStore,
} from './panes/dockStore'
import { ShelfContext } from './panes/ShelfPane'
import { useExcerptStore } from './pdf/excerptState'
import { useOpenPdf, usePdfOpenId } from './pdf/usePdfOpenId'
import type { SessionSnapshot } from './persistence/keys'
import { usePersistedWrite } from './persistence/usePersistedWrite'
import { useSessionSnapshot } from './persistence/useSessionSnapshot'
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

// Single-open coordinator for the v0.5 command-search surfaces: `command` → ⌘K
// CommandMenu, `title` → ⌘O QuickSwitcher, `content` → ⌘P ContentSearch. At most
// one is ever open. Hoisted to module scope so it reads as the coordinator type
// the three palettes share. @see docs/specs/v0.5-command-search.md §4
type ActivePalette = 'none' | 'command' | 'title' | 'content'

/**
 * Root shell for v0.1 — composes Topbar, Feed, Composer, BacklinksPane, and
 * the command-search palettes (⌘K/⌘O/⌘P) around the rolling-feed query/mutation surface.
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
  // Feed query: distinct key ['notes','feed'] so it lives in a separate cache
  // entry from the pickers' ['notes'] key. invalidateQueries({ queryKey: ['notes'] })
  // (prefix match, no exact:true anywhere in the codebase) still invalidates this
  // query on every create/update/delete/excerpt (verified via context7 TanStack Query
  // v5 docs — prefix matching is the default). Canvas pickers keep queryKey:['notes']
  // + api.notes.list() (no flag) → unfiltered, so comment-on children (PDF excerpts
  // placed on the canvas) remain reachable. @issue utof/linsae#165
  const { data: notes = [], isPending: notesPending } = useQuery({
    queryKey: ['notes', 'feed'],
    // limit defaults to 500 (the Zod max) — the NEWEST 500 notes, oldest-first
    // (listNotes). A new note is always in this page; older notes beyond 500 wait
    // on scroll-back pagination (issue #20). The plan literal said 5000 but the
    // schema caps at 500. excludeThreadChildren hides comment-on children (#165)
    // from the feed — they belong only in their thread (PDF thread, YouTube thread).
    queryFn: () => api.notes.list({ excludeThreadChildren: true }),
  })
  // Boot session snapshot (v0.7): one batched read of every persisted session key,
  // consumed only as boot-INITIAL values (never live truth — writers own updates).
  // `snapSettled` is the FAIL-OPEN boot gate (carry-forward A): true once the read has
  // RESOLVED OR ERRORED — gating on `isSuccess` alone would hang the splash forever if
  // `settings.getMany` rejects. Downstream reads `snap.data ?? defaults`; on error
  // `snap.data` is undefined, so `snap.data?.dockLayout` falls to the no-restore path.
  // @see docs/specs/v0.7-session-persistence.md §Architecture
  const snap = useSessionSnapshot()
  const snapSettled = snap.isSuccess || snap.isError
  const [focusedId, setFocusedId] = useState<string | null>(null)
  // v0.7 session-restore refs (Task 2.1). `restoredFocusRef` holds the SPECIFIC id the one-shot
  // boot restore is about to re-seed into `focusedId` (not a bare boolean), set immediately before
  // that `setFocusedId`, then value-matched+cleared by the [focusedId] auto-open-backlinks effect
  // on its next run so the restore does NOT openPane('backlinks') — which would clobber the
  // just-hydrated dock (openPane clears `collapsed[side]` and steals `activeId`). Holding the id
  // (vs a boolean) means the guard suppresses ONLY that exact value's one run, so a lingering ref
  // can never swallow a later genuine focus to a *different* note. `didRestoreSession` makes the
  // restore one-shot. @see docs/specs/v0.7-session-persistence.md §Restore
  const restoredFocusRef = useRef<string | null>(null)
  const didRestoreSession = useRef(false)
  const [activePalette, setActivePalette] = useState<ActivePalette>('none')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null)
  // Dev-overlay state — MUST be called unconditionally (rules of hooks); the store
  // is inert in prod but the hooks must not be gated on import.meta.env.DEV.
  // @see src/renderer/src/dev/devOverlays.ts module doc
  const waveOn = useDevOverlay('wave')
  const revealOpen = useDevOverlay('reveal')
  const [draftBody, setDraftBody] = useState<string | null>(null)
  // v0.7 Task 4.1: the persisted feed composer draft `{ body, mode }` (or null = no draft).
  // Fed by the create Composer's `onDraftChange` and written-through to
  // `composer.draft.feed.v1`; cleared to null on successful send (see createMut.onSuccess).
  // Distinct from `draftBody` (the transient wikilink/New-note PREFILL seed that drives the
  // remount key): `draftFeed` is the durable draft + the ONLY carrier of the restored `mode`.
  const [draftFeed, setDraftFeed] = useState<SessionSnapshot['draftFeed']>(null)
  // Boot restore (render-phase, one-shot): seed `draftFeed` from the snapshot the instant it
  // settles. Done DURING render — not in an effect — so the value is already present when the
  // `snapSettled`-gated create Composer FIRST mounts (below). An effect would land one render
  // later, after the composer had already mounted with `initialBody=''`, and (its key
  // unchanged) it would never pick the restored draft up. React blesses conditional
  // setState-in-render for exactly this "derive state as a prop settles" case; the
  // `draftFeedSeeded` guard makes it fire once, so there is no render loop.
  // @see https://react.dev/reference/react/useState#storing-information-from-previous-renders
  const [draftFeedSeeded, setDraftFeedSeeded] = useState(false)
  if (snapSettled && !draftFeedSeeded) {
    setDraftFeedSeeded(true)
    setDraftFeed(snap.data?.draftFeed ?? null)
  }
  // Narrows the Composer's `NoteType` mode to the draft schema's `'claim' | 'question'` (the
  // create composer never emits 'source'); memoised so it doesn't re-arm the composer's
  // report effect on every App render.
  const handleDraftChange = useCallback(
    (draft: { body: string; mode: NoteType }) =>
      setDraftFeed({ body: draft.body, mode: draft.mode === 'question' ? 'question' : 'claim' }),
    [],
  )
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
  // Whether each dock SIDE is shown (has an active pane AND is not explicitly
  // collapsed — B19). Drives the WindowFrame side toggles' pressed-state and the
  // geometry below (a collapsed/empty side contributes 0 width so the feed reclaims
  // it). The top toggle collapses/restores the WHOLE side, not a single tab.
  const leftShown = useDockStore((s) => isSideShown(s, 'left'))
  const rightShown = useDockStore((s) => isSideShown(s, 'right'))
  // Per-side dock geometry inputs (ADR 0047). App is the geometry owner: it measures
  // the window (bodyWidth) and reads each shown side's active pane + stored width,
  // then derives the window-capped effective widths (B14) below — driving BOTH the
  // feed band and the rendered dock widths from the same numbers so they can't
  // disagree. A hidden (collapsed/empty) side reads as no active pane → 0 width.
  const leftActiveId = useDockStore((s) => (isSideShown(s, 'left') ? s.left.activeId : null))
  const rightActiveId = useDockStore((s) => (isSideShown(s, 'right') ? s.right.activeId : null))
  const leftStoredW = useDockStore((s) => (isSideShown(s, 'left') ? dockWidthFor(s, 'left') : 0))
  const rightStoredW = useDockStore((s) => (isSideShown(s, 'right') ? dockWidthFor(s, 'right') : 0))
  // Width band per side comes from the WIDEST resident pane, NOT the active tab (B15):
  // switching to a narrow utility tab (backlinks) over a content pane (PDF) must not
  // shrink the dock the user sized. @see dockKindFor / adrs/0047.
  const leftDockKind = useDockStore((s) => dockKindFor(s, 'left'))
  const rightDockKind = useDockStore((s) => dockKindFor(s, 'right'))
  const bodyRowRef = useRef<HTMLDivElement | null>(null)
  const [bodyWidth, setBodyWidth] = useState(0)
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
  // v0.7 Task 2.2: per-root thread scroll offsets (rootNoteId → scrollTop). Only the
  // generic (plain/pdf) ThreadView writes here — youtube threads own scroll via the
  // playhead-follow and ThreadView never reports scroll for them, so their ids never
  // land in this map. Seeded ONCE from the boot snapshot (below), then owned locally +
  // persisted to `thread.scroll.v1`. @see docs/specs/v0.7-session-persistence.md §Task 2.2
  const [threadScrollMap, setThreadScrollMap] = useState<Record<string, number>>({})
  const threadScrollSeeded = useRef(false)
  // v0.7 Task 4.2: per-root composer drafts (rootNoteId → draft text). BOTH thread
  // composers (youtube ThreadComposer + plain/pdf SimpleComposer) report here via
  // ThreadView's pass-through, keyed by `threadNoteId`. Seeded ONCE from the boot
  // snapshot (below), then owned locally + persisted to `composer.draft.thread.v1`.
  // @see docs/specs/v0.7-session-persistence.md §Task 4.2
  const [draftThreadMap, setDraftThreadMap] = useState<Record<string, string>>({})
  const draftThreadSeeded = useRef(false)
  // v0.7 Task 3.2: latest feed-scroll capture from <Feed>'s throttled onCapture. Boot
  // RESTORE flows the OTHER way (snap.data.feedScroll → Feed's `restore` prop, seeded at
  // its first render); this state only holds post-boot captures for the debounced writer,
  // so it starts null and `usePersistedWrite` skips it until the first real capture.
  // @see docs/specs/v0.7-session-persistence.md §Feed scroll
  const [feedScroll, setFeedScroll] = useState<SessionSnapshot['feedScroll']>(null)
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

  // Right-dock PDF reader (spec §6): the open-pdf id is persisted in the
  // app_settings store so the dock restores on boot. `openPdf(null)`
  // (pane onClose, via handlePaneClose) clears it.
  const pdfOpenId = usePdfOpenId()
  const openPdf = useOpenPdf()
  // Boot/restore: when the persisted open-pdf id resolves, open its dock pane.
  // The store starts empty (in-memory), so the v0.6 "restore on boot" behavior
  // must be reasserted explicitly here. Intentionally one-way (open only) — the
  // close path flows solely through handlePaneClose, which clears the persisted
  // id so this effect won't reopen it. @see docs/specs/v0.6.2-dock-shell.md §4 (C2)
  useEffect(() => {
    if (pdfOpenId != null) useDockStore.getState().openPane('pdf')
  }, [pdfOpenId])
  // closePane + side effects App owns: closing 'pdf' clears the persisted id
  // (else the restore effect reopens it); 'backlinks' clears focus (I1, Task 6).
  const handlePaneClose = useCallback(
    (paneId: string) => {
      useDockStore.getState().closePane(paneId)
      if (paneId === 'pdf') void openPdf(null)
      if (paneId === 'backlinks') setFocusedId(null)
    },
    [openPdf],
  )
  // Open PDF…: native picker → content-addressed import → set the open-pdf id
  // (the right dock mounts + the next boot restores from `pdf.openDocId`).
  // openPdf is stable (useOpenPdf memoizes), so this stays stable for the
  // command registry. Declared here (above the command-registration effect) so
  // it is in scope for that effect's dep array. @see spec §6
  const onOpenPdf = useCallback(async () => {
    try {
      const { filePaths } = await api.system.chooseFile([{ name: 'PDF', extensions: ['pdf'] }])
      if (!filePaths[0]) return
      const result = await api.pdf.import(filePaths[0])
      await openPdf(result.pdfId)
      // Create-or-resolve the PDF source note so the PDF persists in the feed
      // (idempotent — one note per pdf_id; empty body → uuid slug). @see spec §Data model
      // @see docs/specs/v0.6.4-notes-as-threads.md §Data model
      const existing = await api.notes.findSourceByPdfId(result.pdfId)
      if (!existing) {
        await api.notes.create('', 'source', {
          source_kind: 'pdf',
          source_locator: { media: 'pdf', pdf_id: result.pdfId },
        })
        void queryClient.invalidateQueries({ queryKey: ['notes'] })
        void queryClient.invalidateQueries({ queryKey: ['note-titles'] })
        void queryClient.invalidateQueries({ queryKey: ['note-recent'] })
      }
    } catch (err) {
      console.error('[App] Open PDF failed', err)
    }
  }, [openPdf, queryClient])

  // Widen the pinned-data refetch (spec §3): saves must converge feed↔canvas,
  // and link edits must redraw canvas edges. Invalidates the feed list, every
  // single-note query, and the resolved-edge query.
  // Declared before the excerpt bridge so TypeScript can see it (block-scoped
  // const must appear before any closure that references it).
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['notes'] })
    void queryClient.invalidateQueries({ queryKey: ['note'] }) // every ['note', id]
    void queryClient.invalidateQueries({ queryKey: ['canvas-edges'] })
    // ⌘O switcher feed + recent empty-state (spec §3: note-titles invalidated on
    // create/save/delete). Push-based cache (query-client.ts staleTime:Infinity)
    // never auto-refetches, so the switcher goes stale without this. The
    // ['note-recent'] prefix matches both mode variants (recent | frecent).
    void queryClient.invalidateQueries({ queryKey: ['note-titles'] })
    void queryClient.invalidateQueries({ queryKey: ['note-recent'] })
  }

  // ── PDF excerpt → thread-child bridge (spec §7, v0.6.4 B4) ──────────────
  // The right-dock PDF pane captures a text selection into excerptState; the
  // "Excerpt →" affordance flips `armed`. We watch `armed` (NOT `pending`) so a
  // note is created ONLY on that explicit click — watching `pending` would create
  // on every selection (round-2 review B3). v0.6.4 change: the excerpt becomes
  // a comment-on CHILD of the PDF's source note (so it appears in the PDF thread)
  // with type='claim' instead of 'source'. The forced canvas switch is removed —
  // ghost-placement is now CONDITIONAL on already being in canvas view. Excerpting
  // from feed/thread drops the child into the PDF's thread without yanking to canvas.
  // @issue v0.6.3 PDF "place on canvas" created a note in the feed instead of a ghost
  // @see docs/specs/v0.6.4-notes-as-threads.md §Task 4.1
  const pendingExcerpt = useExcerptStore((s) => s.pending)
  const armed = useExcerptStore((s) => s.armed)
  const clearExcerpt = useExcerptStore((s) => s.clear)
  // biome-ignore lint/correctness/useExhaustiveDependencies: invalidate + clearExcerpt recreate / are stable zustand actions — adding them churns the bridge every render; queryClient is stable from useQueryClient
  useEffect(() => {
    if (!armed || !pendingExcerpt) return
    // Snapshot both values and consume the excerpt store BEFORE any async work.
    // Create-once guarantee: clearExcerpt() sets armed=false + pending=null so
    // any viewMode-triggered re-run sees !armed → early-return without re-creating.
    // viewMode is in deps so modeAtArm captures the correct view at arm-time.
    const snapshot = pendingExcerpt
    const modeAtArm = viewMode
    // MUST stay before the await — moving it below reintroduces the double-create
    // a viewMode-triggered re-run would otherwise cause (see create-once note above).
    clearExcerpt()
    void (async () => {
      try {
        // Resolve the PDF's source note (created on open in Task 3.3).
        // Null-guard: if missing (doc opened before v0.6.4), create it first.
        let src = await api.notes.findSourceByPdfId(snapshot.pdfId)
        if (!src) {
          src = await api.notes.create('', 'source', {
            source_kind: 'pdf',
            source_locator: { media: 'pdf', pdf_id: snapshot.pdfId },
          })
        }
        // Create the excerpt as a comment-on child of the PDF source note.
        // type='claim' (an excerpt is commentary, not a media source reference);
        // commentOn wires it into the PDF's thread so it appears there
        // without requiring a canvas switch (spec §7, v0.6.4 B4).
        const note = await api.notes.create(snapshot.text, 'claim', {
          source_kind: 'pdf',
          source_locator: snapshot.locator,
          commentOn: src.slug,
        })
        // Invalidate feed + title-switcher + recent + the PDF source note's thread
        // so the child appears immediately. Thread queryKey is ['thread', noteId]
        // — see useThreadNotes.ts:92. Invalidate uses the source note's id.
        invalidate()
        void queryClient.invalidateQueries({ queryKey: ['thread', src.id] })
        // Conditional placement: ghost-place only when already on the canvas.
        // Feed / thread view: child is in the PDF's thread — no ghost needed.
        // Canvas view: also ghost-place so the user can drag-position it
        //   (v0.6 place-on-canvas path survives — notes are live canvas refs).
        if (modeAtArm === 'canvas') {
          setPlacing({ noteId: note.id, title: noteTitle(note) })
        }
        // Non-canvas: excerpt already consumed by clearExcerpt() above; done.
        // setViewMode('canvas') intentionally removed (v0.6.4 B4 spec change).
      } catch (err) {
        console.error('[App] excerpt note create failed', err)
        // Restore the consumed excerpt so a failed create doesn't silently lose
        // the user's selection. set() re-stores `pending` with armed:false, so the
        // effect re-runs but early-returns (!armed) — no double-create. The user
        // re-clicks "Excerpt →" to retry. (Without this, the sync clearExcerpt()
        // above would drop the text on any IPC/DB failure — v0.6 kept it.)
        useExcerptStore.getState().set(snapshot)
      }
    })()
    // No cleanup needed: clearExcerpt() already consumed the excerpt store so any
    // viewMode-triggered re-run sees !armed → early-return. Creates are
    // unconditional (the note must land in the DB). React 18 safely ignores
    // setState-after-unmount for the setPlacing call.
  }, [armed, pendingExcerpt, viewMode])
  // Shared placement teardown: clears the canvas ghost AND the excerpt store.
  // Passed to CanvasStage (fires on canvas-click commit AND its capture-phase
  // esc) and reused by App's esc ladder for the focus-outside-canvas case.
  // clearExcerpt() is a no-op for non-PDF placement (feed/shelf), so one shared
  // handler is safe. @see docs/specs/v0.6-pdf-slim-slice.md §7
  const onPlacingDone = useCallback(() => {
    setPlacing(null)
    clearExcerpt()
  }, [clearExcerpt])

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

  // Base command set (spec §4). Registered on mount; each run() either flips
  // `activePalette` (the two search doors) or calls an existing App verb. The
  // effect re-runs on `viewMode` change so the `when` gates re-evaluate and the
  // run() closures stay current. Contextual (canvas/feed) commands are future
  // work. New-note does `setViewMode('feed')` first because the create-mode
  // <Composer> only renders in feed view (App JSX below) — so a canvas ⌘K "New
  // note" is observable instead of silently arming an off-screen draft.
  // ⌘J recent-notes is gated to canvas (mirrors the ⌘J hotkey's
  // `enabled: viewMode==='canvas'`); the popover is a canvas affordance.
  // @see docs/specs/v0.5-command-search.md §4
  useEffect(() => {
    const store = useCommandStore.getState()
    const base: Command[] = [
      {
        id: 'search.title',
        label: 'Search by title',
        hint: '⌘O',
        run: () => setActivePalette('title'),
      },
      {
        id: 'search.content',
        label: 'Search by content',
        hint: '⌘P',
        run: () => setActivePalette('content'),
      },
      {
        id: 'note.new',
        label: 'New note',
        run: () => {
          setViewMode('feed')
          setDraftBody('')
        },
      },
      {
        id: 'view.recent',
        label: 'Recent notes',
        hint: '⌘J',
        when: () => viewMode === 'canvas',
        run: () => setRecentOpen((o) => !o),
      },
      { id: 'app.settings', label: 'Open settings', run: () => setSettingsOpen(true) },
      { id: 'pdf.open', label: 'Open PDF…', run: onOpenPdf },
    ]
    for (const c of base) store.register(c)
    return () => {
      for (const c of base) store.unregister(c.id)
    }
  }, [viewMode, onOpenPdf])

  // Register "Open backlinks" only while a note is focused. A dedicated [focusedId]
  // effect (not a `when` gate) because CommandMenu evaluates when() against the
  // closure captured at registration time, so a register-once
  // `when: () => focusedId != null` would capture the mount-render null and never
  // update. @see docs/specs/v0.6.2-dock-shell.md Decision 5
  useEffect(() => {
    if (focusedId == null) return
    const store = useCommandStore.getState()
    store.register({
      id: 'backlinks.open',
      label: 'Open backlinks',
      run: () => useDockStore.getState().openPane('backlinks'),
    })
    return () => store.unregister('backlinks.open')
  }, [focusedId])

  // Focus ↔ backlinks-pane coupling (B6 / ADR 0047). Focusing a note OPENS the
  // backlinks dock pane (this folds in the retired transient overlay's "show on
  // focus" behavior — Model A's gutter layout removed the shift that justified a
  // separate overlay, so 0046's dual surface collapses to one dock pane). Clearing
  // focus auto-closes it (I2: a backlinks pane with no subject is dead chrome).
  // Idempotent with I1's close→clear-focus (handlePaneClose): after a tab/header
  // close the pane is already gone, so the null-focus branch is a no-op — no loop.
  useEffect(() => {
    // Task 2.1 backlinks-suppression: skip exactly the restore-sourced first run. The boot
    // restore re-seeds `focusedId` from persistence; opening backlinks here would clobber the
    // just-hydrated dock (openPane clears `collapsed[side]` + repoints `activeId`). Value-match
    // the restored id (not a bare boolean) so ONLY that exact value's one run is skipped — a
    // focus to a *different* note (even one racing the restore) can never be swallowed.
    if (focusedId != null && focusedId === restoredFocusRef.current) {
      restoredFocusRef.current = null
      return
    }
    const dock = useDockStore.getState()
    if (focusedId != null) dock.openPane('backlinks')
    else if (dock.right.openPaneIds.includes('backlinks')) dock.closePane('backlinks')
  }, [focusedId])

  // Body-row width for the "Model A" feed band (ADR 0047). The body row spans the
  // full window width; combined with the open dock widths the feed centers in the
  // window and shrinks only when a dock encroaches. happy-dom reports 0 (no layout)
  // → computeFeedBand returns null → the feed uses its default centered band.
  useEffect(() => {
    const el = bodyRowRef.current
    if (!el) return
    setBodyWidth(el.getBoundingClientRect().width)
    const ro = new ResizeObserver(() => setBodyWidth(el.getBoundingClientRect().width))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Remove the static boot splash (index.html #boot-splash) once the notes
  // query has settled. The splash paints on the first frame — before the JS
  // module graph mounts — so the window appears immediately instead of after
  // React is ready; keeping it until `notesPending` flips false also covers the
  // post-mount notes-IPC gap, so the feed crossfades straight in with no
  // "nothing yet" flash. The splash lives outside React's #root (createRoot
  // never touches it), so we remove it imperatively. This effect runs after the
  // commit that rendered the feed has painted, so we reveal a painted feed.
  //
  // v0.7 FAIL-OPEN boot gate (carry-forward A): also hold the splash until the session
  // snapshot has SETTLED (`snapSettled` = isSuccess||isError), so Feed's first render can
  // receive the restored layout/scroll. Gating on `isSuccess` ALONE would white-splash-hang
  // forever if `settings.getMany` rejects — so we fail open on the error too and reveal a
  // no-restore feed. @see docs/specs/v0.7-session-persistence.md §Architecture
  useEffect(() => {
    if (notesPending || !snapSettled) return
    const splash = document.getElementById('boot-splash')
    if (!splash) return
    splash.classList.add('boot-splash--hide')
    const t = window.setTimeout(() => splash.remove(), 360)
    return () => window.clearTimeout(t)
  }, [notesPending, snapSettled])

  // Boot: hydrate the dock from the persisted layout EXACTLY ONCE, then arm the persist
  // writer. Double-hydrate guard (carry-forward B): a StrictMode double-invoke of this
  // effect must not call `hydrate` twice — the 2nd would be a `hydrated=true→true`
  // transition that `subscribeDockPersist` would echo as a redundant boot write. Always
  // mark hydrated once the snapshot settles (no saved layout, or error → `snap.data`
  // undefined) so the writer can arm on the first genuine post-boot change.
  // @see src/renderer/src/panes/dockStore.ts — hydrate / subscribeDockPersist
  useEffect(() => {
    if (useDockStore.getState().hydrated) return
    if (snap.data?.dockLayout) useDockStore.getState().hydrate(snap.data.dockLayout)
    else if (snapSettled) useDockStore.setState({ hydrated: true })
  }, [snap.data, snapSettled])

  // Persist writer (v0.7): subscribe once at mount. `subscribeDockPersist` debounces and
  // SKIPS the hydrate transition itself, writing only genuine post-boot dock changes to
  // `dock.layout.v1`; its returned unsub clears the pending timer on unmount.
  useEffect(() => subscribeDockPersist((s) => void api.settings.set('dock.layout.v1', s)), [])

  // Synchronous slug-only resolver for the Markdown component's dangling
  // class pass. The full alias-aware resolver runs only on click (below).
  const slugSet = useMemo(
    () => new Set(notes.filter((n) => !n.deleted_at).map((n) => n.slug)),
    [notes],
  )
  const resolveSlug = (slug: string) => slugSet.has(slug.toLowerCase().trim())

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
        // Switcher feed + recent empty-state (spec §3) — this create path does not
        // go through invalidate(), so mirror its ['note-titles']/['note-recent'] keys.
        void queryClient.invalidateQueries({ queryKey: ['note-titles'] })
        void queryClient.invalidateQueries({ queryKey: ['note-recent'] })
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
      // v0.7: clear the persisted draft on send. Setting it null CANCELS any pending draft
      // write (usePersistedWrite's value-change cleanup) and schedules a null write, so a
      // late debounce can't re-persist the just-sent text. Runs before the successCount tick
      // remounts the composer (whose empty remount, skip-first, won't re-report a draft).
      setDraftFeed(null)
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
      setActivePalette((p) => (p === 'command' ? 'none' : 'command'))
    },
    { enableOnFormTags: ['textarea', 'input'] },
  )
  // ⌘O → quick-switcher toggle (spec §5). Toggles the `title` slot of the
  // single-open coordinator.
  useHotkeys(
    'mod+o',
    (e) => {
      e.preventDefault()
      setActivePalette((p) => (p === 'title' ? 'none' : 'title'))
    },
    { enableOnFormTags: ['textarea', 'input'] },
  )
  // ⌘P → content-search toggle (spec §6). Toggles the `content` slot — the
  // FTS5 surface, jumping with the ⌘O `jump`-access verb (onSwitcherJump).
  useHotkeys(
    'mod+p',
    (e) => {
      e.preventDefault()
      setActivePalette((p) => (p === 'content' ? 'none' : 'content'))
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
  // App's global esc ladder (settings → palette → placement → focused pane). Each
  // rung guards on its OWN state boolean, so this is a no-op when none of App's
  // overlays are open. This is a BUBBLE-phase document listener (react-hotkeys-hook's default).
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
      // ⌘K / ⌘O / ⌘P surfaces (all on `activePalette`) close before clearing
      // feed focus. Each surface's own Command.Input esc stopPropagation's, so
      // this rung covers the case where focus already left the input — both
      // paths set 'none', so it is idempotent.
      if (activePalette !== 'none') {
        setActivePalette('none')
        return
      }
      // One-shot placement (incl. a PDF excerpt armed from the right dock): Esc
      // cancels it when focus is OUTSIDE the canvas viewport (e.g. the PDF pane).
      // Inside the canvas, CanvasStage's capture-phase esc handler consumes it
      // first — calling this same onPlacingDone — so the two never double-fire.
      if (placing) {
        onPlacingDone()
        return
      }
      if (focusedId) {
        setFocusedId(null)
      }
    },
    { enableOnFormTags: ['textarea', 'input'] },
    [settingsOpen, activePalette, focusedId, placing, onPlacingDone],
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
   * Opens the PDF reader dock for a specific pdf_id without navigating to its
   * thread (#168). Called by the feed's PdfFeedNote title-click path (via Feed →
   * NoteBubble → PdfFeedNoteContainer → PdfFeedNote). Mirrors ThreadView.tsx's
   * PDF-open effect: writes `pdf.openDocId` asynchronously (so the setting persists
   * across restarts) and calls `openPane('pdf')` synchronously (so the dock opens
   * immediately without waiting for the DB write).
   *
   * @issue utof/linsae#168
   */
  const handleOpenPdfReader = useCallback(
    (pdfId: string) => {
      void openPdf(pdfId)
      useDockStore.getState().openPane('pdf')
    },
    [openPdf],
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

  // Boot session-restore (Task 2.1): once the snapshot first resolves, restore the persisted
  // selection — THREAD WINS. If a persisted thread's note still exists, open it and IGNORE the
  // persisted focus (the `return`; openThread itself clears focusedId). Otherwise re-seed the
  // persisted focus if ITS note still exists. Stale-drop: `api.notes.get` returns null (not a
  // throw) for a missing/soft-deleted id, so the `&&` silently drops a deleted target — a stale
  // id can't crash boot. `didRestoreSession` (set synchronously) makes this one-shot: it need
  // only react to `snap.data` first resolving. @see docs/specs/v0.7-session-persistence.md
  // biome-ignore lint/correctness/useExhaustiveDependencies: one-shot (didRestoreSession guards re-runs); the effect fires when snap.data first resolves and captures openThread's closure over stable setters — listing openThread (recreated each render) would churn without changing behavior
  useEffect(() => {
    if (!snap.data || didRestoreSession.current) return
    didRestoreSession.current = true
    const s = snap.data.uiSession
    if (!s) return
    void (async () => {
      if (s.threadNoteId && (await api.notes.get(s.threadNoteId))) {
        openThread(s.threadNoteId)
        return
      }
      if (s.focusedNoteId && (await api.notes.get(s.focusedNoteId))) {
        restoredFocusRef.current = s.focusedNoteId // suppress the auto-open-backlinks run for THIS id
        setFocusedId(s.focusedNoteId)
      }
    })()
  }, [snap.data])

  // Persist the selection to `ui.session.v1`, debounced. `enabled: snapSettled`
  // (isSuccess || isError), NOT `snap.isSuccess` alone — a transient snapshot-read failure must
  // not disable session persistence for the whole session (fail-open, matching the dock writer's
  // boot arming). `usePersistedWrite` skips the initial (restored) value. @see spec §Write-through
  usePersistedWrite(
    'ui.session.v1',
    useMemo(() => ({ focusedNoteId: focusedId, threadNoteId }), [focusedId, threadNoteId]),
    { debounceMs: 400, enabled: snapSettled },
  )

  // Seed the thread-scroll map ONCE from the boot snapshot (Task 2.2). Must run in an
  // effect (the snapshot resolves async), gated on `snapSettled`. Seeding the FULL map
  // is load-bearing: persisting a map that started empty would wipe other threads'
  // saved offsets on the first scroll. Skip the seed when there's no saved history so
  // the map ref stays `{}` and `usePersistedWrite` writes nothing on a fresh boot.
  useEffect(() => {
    if (threadScrollSeeded.current || !snapSettled) return
    threadScrollSeeded.current = true
    const saved = snap.data?.threadScroll
    if (saved && Object.keys(saved).length > 0) setThreadScrollMap(saved)
  }, [snapSettled, snap.data])

  // Generic-thread scroll report (Task 2.2): ThreadView reports (trailing-throttled)
  // only for plain/pdf roots, so `threadNoteId` is the correct key. Youtube never
  // reports, so no youtube id is ever stored here.
  const onThreadScroll = useCallback(
    (scrollTop: number) => {
      if (!threadNoteId) return
      setThreadScrollMap((m) => ({ ...m, [threadNoteId]: scrollTop }))
    },
    [threadNoteId],
  )

  // Persist the whole per-root scroll map, debounced. `enabled: snapSettled` (fail-open,
  // matching the dock + ui.session writers); `usePersistedWrite` skips the seeded value.
  usePersistedWrite('thread.scroll.v1', threadScrollMap, { debounceMs: 250, enabled: snapSettled })

  // Seed the per-root draft map ONCE from the boot snapshot (Task 4.2). Mirrors the
  // thread-scroll seed above: async snapshot → effect, gated on `snapSettled`. Seeding
  // the FULL map is load-bearing — a map that started empty would wipe other threads'
  // saved drafts on the first keystroke. Skip when there's no saved history so the map
  // ref stays `{}` and `usePersistedWrite` writes nothing on a fresh boot.
  useEffect(() => {
    if (draftThreadSeeded.current || !snapSettled) return
    draftThreadSeeded.current = true
    const saved = snap.data?.draftThread
    if (saved && Object.keys(saved).length > 0) setDraftThreadMap(saved)
  }, [snapSettled, snap.data])

  // Per-thread draft report (Task 4.2): both composers report text-only via ThreadView;
  // `threadNoteId` is the correct key (a thread is open whenever a composer can report).
  const onThreadDraftChange = useCallback(
    (text: string) => {
      if (!threadNoteId) return
      setDraftThreadMap((m) => ({ ...m, [threadNoteId]: text }))
    },
    [threadNoteId],
  )

  // On send, drop this root's entry so a late debounce can't resurrect the just-sent draft.
  const onThreadDraftClear = useCallback(() => {
    if (!threadNoteId) return
    setDraftThreadMap((m) => {
      const n = { ...m }
      delete n[threadNoteId]
      return n
    })
  }, [threadNoteId])

  // Persist the whole per-root draft map, debounced. `enabled: snapSettled` (fail-open,
  // matching the other writers); `usePersistedWrite` skips the seeded value so a restored
  // draft isn't echoed on boot.
  usePersistedWrite('composer.draft.thread.v1', draftThreadMap, {
    debounceMs: 400,
    enabled: snapSettled,
  })

  // Persist the latest feed-scroll capture, debounced. `enabled: snapSettled` (fail-open,
  // matching the other writers — NOT `snap.isSuccess`, which would disable feed-scroll
  // persistence for the whole session on a transient snapshot-read failure). Starts null →
  // `usePersistedWrite` skips it until <Feed> reports the first real capture.
  usePersistedWrite('feed.scroll.v1', feedScroll, { debounceMs: 250, enabled: snapSettled })

  // Persist the feed composer draft, debounced. `enabled: snapSettled` (fail-open, matching the
  // other writers); `usePersistedWrite` skips the seeded value so the restored draft isn't
  // echoed on boot. On successful send, createMut.onSuccess sets `draftFeed` to null — which
  // CANCELS any pending draft write (value-change cleanup) and schedules a null write, clearing
  // the key so a late debounce can't resurrect the just-sent draft.
  // @see docs/specs/v0.7-session-persistence.md §Composer draft
  usePersistedWrite('composer.draft.feed.v1', draftFeed, { debounceMs: 400, enabled: snapSettled })

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
  // ⌘O switcher jump: focus the note in the feed (the existing focus path, view-
  // agnostic) and record a `jump` access. NOT onJumpToCard — ⌘O is a vault-wide
  // title door whose hits are mostly unplaced; feed-focus mirrors the old ⌘K verb.
  // @see docs/plans/v0.5-command-search.md "Jump-verb decision"
  const onSwitcherJump = useCallback((id: string) => {
    void api.notes.recordAccess(id, 'jump')
    setFocusedId(id)
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

  // BacklinksContext value (mirrors shelfContextValue) — feeds the backlinks dock
  // pane's prop-free body the focused note + jump verb. The overlay re-provides its
  // own (identical) values locally. @see docs/specs/v0.6.2-dock-shell.md §3
  const backlinksContextValue = useMemo(() => ({ focusedId, onJump: setFocusedId }), [focusedId])

  // Dock geometry (B14 / ADR 0047). Per side: `max` is the window-aware resize cap
  // (so a drag can't push the feed below its min or overlap it — capping each side
  // against the OTHER side's width keeps the result consistent for any pane/dock
  // count), and `eff` is the effective render width = min(stored, max), which also
  // re-caps a previously-stored width when the window shrinks. Before measurement
  // (bodyWidth ≤ 0) capping is skipped so the dock renders at its stored width with
  // no flash. The SAME eff widths feed both the dock render and the feed band, so
  // the dock can never overlap the feed at any width.
  const dockGeom = useMemo(() => {
    const resolve = (
      activeId: string | null,
      kind: PaneKind,
      stored: number,
      otherStored: number,
    ) => {
      if (!activeId) return { eff: 0, max: 0 }
      if (bodyWidth <= 0) return { eff: stored, max: stored }
      // `kind` is the DOCK's band (widest resident pane), not the active pane's — so
      // activating a utility tab over a content pane never re-caps the width down.
      const max = maxDockWidth(kind, otherStored, bodyWidth)
      return { eff: Math.min(stored, max), max }
    }
    return {
      left: resolve(leftActiveId, leftDockKind, leftStoredW, rightStoredW),
      right: resolve(rightActiveId, rightDockKind, rightStoredW, leftStoredW),
    }
  }, [
    leftActiveId,
    rightActiveId,
    leftDockKind,
    rightDockKind,
    leftStoredW,
    rightStoredW,
    bodyWidth,
  ])

  // "Model A" feed band (ADR 0047): null while no dock is open (feed uses its
  // default centered band) or before the body width is measured. Fed the EFFECTIVE
  // (capped) dock widths so it agrees with what the docks actually render.
  const feedBand = useMemo(
    () => computeFeedBand(bodyWidth, dockGeom.left.eff, dockGeom.right.eff),
    [bodyWidth, dockGeom],
  )

  // B4 — feed→canvas selection carry-over. When a note is focused in the feed and
  // its card is placed on the canvas, hand its id to CanvasStage so it selects the
  // card on the view switch. Gated on `placedNoteIds` so we never select a note
  // that isn't on the canvas. One-directional (feed focus → canvas selection);
  // CanvasStage reads it once at mount (it remounts on each feed→canvas swap).
  // @see adrs/0047-feed-default-width-docks-fill-gutters.md
  const canvasSelectId = focusedId && placedNoteIds.has(focusedId) ? focusedId : null

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
      {/* BacklinksContext feeds the dock pane's prop-free body (spec §3); both
       DockHosts and the transient overlay live inside it. */}
      <BacklinksContext.Provider value={backlinksContextValue}>
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
            onOpenPalette={() => setActivePalette('command')}
            onOpenSettings={() => setSettingsOpen(true)}
            view={viewMode}
            onViewChange={setViewMode}
            dockOpen={leftShown}
            onToggleDock={() => useDockStore.getState().toggleSide('left')}
            backlinksOpen={rightShown}
            onToggleBacklinks={() => useDockStore.getState().toggleSide('right')}
          />
          {/* Body row: [left dock][center stage][right dock] (ADR 0045). bodyRowRef
         feeds the "Model A" feed-band measurement (ADR 0047) — its width is the
         window width the feed centers within while docks fill the side gutters.
         Both DockHosts are ALWAYS mounted (v0.6.4 B1); the thread is a branch
         INSIDE <main>, peer to canvas/feed, so the docked PDF reader / YouTube
         player is never torn down on thread open. key={threadNoteId} on ThreadView
         forces a remount when switching threads so the player singleton and duration
         write-back state reset per video. */}
          <div
            ref={bodyRowRef}
            style={{
              display: 'flex',
              flex: 1,
              minHeight: 0,
              position: 'relative',
            }}
          >
            <>
              {/* Left dock — always mounted (v0.6.4 B1): thread is a sub-state of
              <main>, so the dock coexists with all center stages (canvas/thread/feed).
              DockHost self-hides when its side is empty (store owns open/active/width). */}
              <DockHost
                side="left"
                onPaneClose={handlePaneClose}
                width={dockGeom.left.eff}
                maxWidth={dockGeom.left.max}
              />
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
                        selectNoteId={canvasSelectId}
                        placing={placing}
                        onPlacingDone={onPlacingDone}
                        onCameraChange={handleCameraChange}
                        fitSignal={fitSignal}
                        resetSignal={resetSignal}
                        jumpTo={jumpTo}
                      />
                    </motion.div>
                  ) : threadNoteId ? (
                    /* Thread is a feed sub-state: canvas wins over thread;
                       toggling canvas while a thread is open shows the canvas,
                       toggling back reveals the thread again (v0.6.4 B1). */
                    <motion.div
                      key="thread"
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
                      <ThreadView
                        key={threadNoteId}
                        noteId={threadNoteId}
                        onClose={() => setThreadNoteId(null)}
                        onWikilinkClick={onWikilinkClick}
                        // v0.7 Task 2.2: keyed on threadNoteId (= root id). ThreadView
                        // applies/attaches these ONLY for plain/pdf roots — youtube's
                        // playhead-follow owns scroll, so it ignores them.
                        initialScrollTop={threadScrollMap[threadNoteId]}
                        onScroll={onThreadScroll}
                        // v0.7 Task 4.2: keyed on threadNoteId (= root id). Forwarded to
                        // BOTH composers (youtube + plain/pdf) — unlike scroll, drafts
                        // apply to every branch.
                        initialDraft={draftThreadMap[threadNoteId]}
                        onDraftChange={onThreadDraftChange}
                        onDraftClear={onThreadDraftClear}
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
                      {/* v0.7: gate Feed's FIRST mount on `snapSettled` so its initial
                          render can receive `restore` from the session snapshot (Batch 3);
                          the splash covers this pre-settle gap, so `null` is never seen.
                          LOAD-BEARING for feed-scroll restore: Feed must FIRST-mount with notes
                          PRESENT (the notes.length===0 placeholder branch defers the mount until
                          they arrive), because the virtualizer consumes `initialOffset` /
                          `initialMeasurementsCache` ONLY at its first render. If Feed ever
                          first-mounts on an empty feed, `scrollOffset` locks to 0 and the restore
                          silently lands at the top — do NOT relax this notes-present gate. */}
                      {!snapSettled ? null : notes.length === 0 ? (
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
                          band={feedBand}
                          // v0.7 Task 3.2: boot restore (seeded at Feed's first render —
                          // App gates this mount on `snapSettled`) + throttled capture up.
                          restore={snap.data?.feedScroll ?? undefined}
                          onCapture={setFeedScroll}
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
                          onOpenReader={handleOpenPdfReader}
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
                          band={feedBand}
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
                      ) : snapSettled ? (
                        // v0.7: gated on `snapSettled` so the create composer FIRST-mounts with
                        // the render-phase-seeded `draftFeed` already present — that is what makes
                        // the boot draft restore land in the textarea (the splash covers the
                        // pre-settle gap, mirroring the Feed gate above).
                        // Composite key: `draftBody ?? 'fresh'` handles the dangling-wikilink
                        // prefill remount; `successCount` ticks on successful create to force a
                        // remount → fresh empty textarea. Failed creates leave the key unchanged
                        // so the user's text + cursor survive.
                        <Composer
                          key={`${draftBody ?? 'fresh'}-${successCount}`}
                          band={feedBand}
                          // A live prefill (`draftBody`) wins over the restored/live draft; else
                          // the persisted `draftFeed` seeds body + mode. Prefills are always claim
                          // (a titled new note), so mode comes from `draftFeed` ONLY when there's
                          // no active prefill — preserving the old hard-coded 'claim' for prefills.
                          initialBody={draftBody ?? draftFeed?.body ?? ''}
                          initialMode={draftBody != null ? 'claim' : (draftFeed?.mode ?? 'claim')}
                          error={submitError}
                          onClearError={() => setSubmitError(null)}
                          onDraftChange={handleDraftChange}
                          // Flag the send so the Feed suppresses its auto-scroll while the new
                          // note glides in (see `beginSend`), THEN create it.
                          onSubmit={({ body, type }) => {
                            beginSend()
                            createMut.mutate({ body, type })
                          }}
                          onCancel={() => setDraftBody(null)}
                          onPasteText={handlePasteText}
                        />
                      ) : null}
                    </motion.div>
                  )}
                </AnimatePresence>
              </main>
              {/* Right dock — always mounted (v0.6.4 B1). Hosts the PDF pane
              (restore effect / Open PDF…) AND the backlinks pane as peer tabs
              (B6 / ADR 0047); both close via handlePaneClose (I1 clears focus
              for backlinks). View-independent chrome: close × reachable from
              canvas view too (B5). */}
              <DockHost
                side="right"
                onPaneClose={handlePaneClose}
                width={dockGeom.right.eff}
                maxWidth={dockGeom.right.max}
              />
            </>
          </div>
          {/* App-wide footer (spec §14): the status strip plus the recent popover it
          anchors. position:relative so RecentPopover (position:absolute,
          bottom:100%) floats UP from the strip. Always mounted alongside the
          thread — the thread owns its own back-bar title, the global StatusBar
          stays (v0.6.4 B1). */}
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
              onOpenShelf={() => useDockStore.getState().openPane('shelf')}
              onResetZoom={() => setResetSignal((s) => s + 1)}
              onFit={() => setFitSignal((s) => s + 1)}
              onToggleRecent={() => setRecentOpen((o) => !o)}
            />
          </div>
          <CommandMenu
            open={activePalette === 'command'}
            onClose={() => setActivePalette('none')}
          />
          <QuickSwitcher
            open={activePalette === 'title'}
            onJump={onSwitcherJump}
            onClose={() => setActivePalette('none')}
          />
          <ContentSearch
            open={activePalette === 'content'}
            onClose={() => setActivePalette('none')}
            onJump={onSwitcherJump}
          />
          <SettingsPanel open={settingsOpen} onClose={() => setSettingsOpen(false)} />
          {/* B16: window-level placement ghost — follows the cursor over the whole
              window (dock/PDF included) while a one-shot placement is active, so the
              note "in hand" is always visible. The drop still commits only on the
              canvas via CanvasStage's viewport click→placeAt path. */}
          {placing && <PlacementGhost title={placing.title} />}
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
      </BacklinksContext.Provider>
    </ShelfContext.Provider>
  )
}
