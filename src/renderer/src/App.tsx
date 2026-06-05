import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { useHotkeys } from 'react-hotkeys-hook'
import type { Note, NoteType } from '../../shared/types'
import { BacklinksPane } from './backlinks/BacklinksPane'
import { Composer } from './composer/Composer'
import { Feed } from './feed/Feed'
import { api } from './lib/api'
import { parseYouTubeUrl } from './lib/parse-youtube-url'
import { CommandPalette } from './palette/CommandPalette'
import { SettingsPanel } from './settings/SettingsPanel'
import { ThreadView } from './thread/ThreadView'
import { WindowFrame } from './topbar/WindowFrame'

// DEV-only reveal-animation playground (mod+shift+R). Lazy + DEV-gated so it is never
// bundled into production. @see src/renderer/src/dev/RevealPlayground.tsx
const RevealPlayground = import.meta.env.DEV
  ? lazy(() => import('./dev/RevealPlayground').then((m) => ({ default: m.RevealPlayground })))
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
  const [playgroundOpen, setPlaygroundOpen] = useState(false)
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null)
  const [draftBody, setDraftBody] = useState<string | null>(null)
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
  // window where the make-room scroll-glide (`useAppendReveal`) owns the scroll —
  // without it, the new row's first measure rides the scroll up and rapid sends
  // desync the rendered range (the #66 white wall). The note simply rises into view
  // via the glide; there is no flying ghost (ADR 0020 supersedes ADR 0018).
  const feedScrollerRef = useRef<HTMLDivElement | null>(null)
  const [sendInFlight, setSendInFlight] = useState(false)
  const sendingTimerRef = useRef<number | undefined>(undefined)
  useEffect(
    () => () => {
      if (sendingTimerRef.current !== undefined) clearTimeout(sendingTimerRef.current)
    },
    [],
  )
  const beginSend = () => {
    setSendInFlight(true)
    if (sendingTimerRef.current !== undefined) clearTimeout(sendingTimerRef.current)
    // Cover create (async) + the ~0.4s reveal; the Feed's own `revealing` flag takes
    // over for the glide itself, so this only needs to bridge submit → append. Scales
    // with the dev slow-mo so debugging at `__morphSlow` keeps the suppression on.
    const ms = import.meta.env.DEV ? 700 * (window.__morphSlow ?? 1) : 700
    sendingTimerRef.current = window.setTimeout(() => setSendInFlight(false), ms)
  }

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

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['notes'] })

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
      setPlaygroundOpen((o) => !o)
    },
    { enabled: import.meta.env.DEV, enableOnFormTags: ['textarea', 'input'] },
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

  return (
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
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onJump={setFocusedId}
      />
      <SettingsPanel open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      {import.meta.env.DEV && playgroundOpen && RevealPlayground && (
        <Suspense fallback={null}>
          <RevealPlayground onClose={() => setPlaygroundOpen(false)} />
        </Suspense>
      )}
    </div>
  )
}
