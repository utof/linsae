import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import { useHotkeys } from 'react-hotkeys-hook'
import type { Note, NoteType } from '../../shared/types'
import { BacklinksPane } from './backlinks/BacklinksPane'
import { Composer } from './composer/Composer'
import { Feed } from './feed/Feed'
import { api } from './lib/api'
import { CommandPalette } from './palette/CommandPalette'
import { Topbar } from './topbar/Topbar'

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
  const { data: notes = [] } = useQuery({
    queryKey: ['notes'],
    // limit: defaults to 100 via the Zod schema. The plan literal said 5000 but
    // NotesListInputSchema caps limit at 500 (zod-schemas.ts:60), so 5000 throws.
    // True infinite scroll / pagination is tracked in issue #20 for v0.1.1+.
    queryFn: () => api.notes.list(),
  })
  const [focusedId, setFocusedId] = useState<string | null>(null)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null)
  const [draftBody, setDraftBody] = useState<string | null>(null)
  const [skipBannerDismissed, setSkipBannerDismissed] = useState(false)
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

  // Clear submitError whenever the composer's context changes (user clicks
  // edit on a different note, opens a dangling-wikilink draft, etc.). Without
  // this, an unrelated create error from a previous attempt would briefly
  // render in the new edit-mode composer until the first keystroke.
  // biome-ignore lint/correctness/useExhaustiveDependencies: setSubmitError is stable
  useEffect(() => {
    setSubmitError(null)
  }, [editingNoteId, draftBody])

  // Synchronous slug-only resolver for the Markdown component's dangling
  // class pass. The full alias-aware resolver runs only on click (below).
  const slugSet = useMemo(
    () => new Set(notes.filter((n) => !n.deleted_at).map((n) => n.slug)),
    [notes],
  )
  const resolveSlug = (slug: string) => slugSet.has(slug.toLowerCase().trim())

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['notes'] })

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
      if (paletteOpen) {
        setPaletteOpen(false)
        return
      }
      if (focusedId) {
        setFocusedId(null)
      }
    },
    { enableOnFormTags: ['textarea', 'input'] },
    [paletteOpen, focusedId],
  )

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
        height: '100vh',
        overflow: 'hidden',
        background: 'var(--bg-0)',
      }}
    >
      <main
        style={{
          display: 'flex',
          flexDirection: 'column',
          flex: 1,
          minWidth: 0,
          minHeight: 0,
        }}
      >
        <Topbar onOpenPalette={() => setPaletteOpen(true)} />
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
            onSubmit={({ body, type }) => updateMut.mutate({ id: editingNote.id, body, type })}
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
            onSubmit={({ body, type }) => createMut.mutate({ body, type })}
            onCancel={() => setDraftBody(null)}
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
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onJump={setFocusedId}
      />
    </div>
  )
}
