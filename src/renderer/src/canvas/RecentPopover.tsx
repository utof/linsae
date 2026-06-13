/**
 * Recent-canvas popover (spec §14): lists ~8 notes last touched on this canvas
 * with kind labels (`edited · 2m`, `placed · yesterday`, `created here · 1h`).
 * Opens upward, dock-menu style. Rendered by App (Task 10) positioned above
 * the status bar. ↵/click jumps to the card; esc closes.
 *
 * Why react-query `['canvas-recent','root']`: the key is scoped to the root
 * canvas and matches nothing else in the cache — safe to invalidate separately.
 * Note titles are resolved via individual `['note', id]` queries (seeded from
 * the feed's `['notes']` cache, NoteCard idiom) so they appear instantly on
 * first render even if the popover just opened.
 *
 * @see docs/specs/v0.4-canvas-mvp.md §14
 * @see src/renderer/src/canvas/recency-format.ts (recentLabel)
 * @see src/renderer/src/canvas/NoteCard.tsx (placeholderData idiom)
 */
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { MANUAL_ARRANGEMENT_ID, ROOT_CANVAS_ID } from '../../../shared/canvas'
import type { Note } from '../../../shared/types'
import { api } from '../lib/api'
import { noteTitle } from '../lib/note-title'
import { recentLabel } from './recency-format'

interface Props {
  /** When false the component renders nothing. */
  open: boolean
  onClose: () => void
  /** Called when the user selects an entry; caller pans + ring-flashes. */
  onJump: (noteId: string) => void
}

/**
 * One row in the recent popover. Fetches its note for `noteTitle` display,
 * seeded from the feed cache (NoteCard placeholderData idiom) so it appears
 * without a flash on first open.
 * @see src/renderer/src/canvas/NoteCard.tsx
 */
function RecentRow({
  noteId,
  label,
  onSelect,
}: {
  noteId: string
  label: string
  onSelect: () => void
}): React.JSX.Element {
  const queryClient = useQueryClient()
  const { data: note } = useQuery({
    queryKey: ['note', noteId],
    queryFn: () => api.notes.get(noteId),
    placeholderData: () =>
      queryClient.getQueryData<Note[]>(['notes'])?.find((n) => n.id === noteId),
  })

  const title = note ? noteTitle(note) : noteId

  return (
    <button
      type="button"
      onClick={onSelect}
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        width: '100%',
        padding: '7px 12px',
        background: 'none',
        border: 'none',
        borderRadius: 'var(--r-2)',
        cursor: 'pointer',
        textAlign: 'left',
        gap: 12,
        fontFamily: 'var(--font-sans)',
        fontSize: 'var(--t-13)',
        color: 'var(--fg-1)',
      }}
      onMouseEnter={(e) => {
        ;(e.currentTarget as HTMLButtonElement).style.background = 'var(--bg-2)'
      }}
      onMouseLeave={(e) => {
        ;(e.currentTarget as HTMLButtonElement).style.background = 'none'
      }}
    >
      <span
        style={{
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          flexShrink: 1,
          minWidth: 0,
        }}
      >
        {title}
      </span>
      <span
        style={{
          flexShrink: 0,
          fontSize: 'var(--t-12)',
          color: 'var(--fg-3)',
          whiteSpace: 'nowrap',
        }}
      >
        {label}
      </span>
    </button>
  )
}

/**
 * Recent-canvas popover. Returns null when `open` is false so App can always
 * render it and it self-hides without conditional JSX in App (Task 10 latitude).
 * @see docs/specs/v0.4-canvas-mvp.md §14
 */
export function RecentPopover({ open, onClose, onJump }: Props): React.JSX.Element | null {
  const { data: entries = [] } = useQuery({
    queryKey: ['canvas-recent', ROOT_CANVAS_ID],
    queryFn: () =>
      api.canvas.recentOnCanvas({
        canvasId: ROOT_CANVAS_ID,
        arrangementId: MANUAL_ARRANGEMENT_ID,
        limit: 8,
      }),
    enabled: open,
  })

  // Esc closes the popover; stop propagation so the canvas esc cascade
  // doesn't also fire (the popover is the highest-priority esc consumer
  // when open — spec §15 cascade order).
  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('keydown', handler, { capture: true })
    return () => document.removeEventListener('keydown', handler, { capture: true })
  }, [open, onClose])

  if (!open) return null

  const now = Date.now()

  return (
    <div
      data-canvas-recent-popover
      style={{
        position: 'absolute',
        bottom: '100%',
        right: 0,
        marginBottom: 6,
        width: 320,
        background: 'var(--bg-0)',
        border: '1px solid var(--border-0)',
        borderRadius: 'var(--r-3)',
        boxShadow: 'var(--shadow-3)',
        padding: '4px 0',
        zIndex: 100,
      }}
    >
      {entries.length === 0 ? (
        <div
          style={{
            padding: '10px 12px',
            fontSize: 'var(--t-13)',
            fontFamily: 'var(--font-sans)',
            color: 'var(--fg-3)',
          }}
        >
          nothing here yet
        </div>
      ) : (
        entries.map((entry) => (
          <RecentRow
            key={entry.noteId}
            noteId={entry.noteId}
            label={recentLabel(entry, now)}
            onSelect={() => {
              onJump(entry.noteId)
              onClose()
            }}
          />
        ))
      )}
    </div>
  )
}
