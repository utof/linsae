/**
 * Shelf pane body — the placement queue (spec §4). Two quiet groups:
 * **"to place (N)"** (layout rows with `x === null`, newest first by
 * `created_at` desc) and **"recently placed"** (the last 10 placed rows by
 * `placed_at` desc). Each row shows a type glyph + derived title + a ▦ chip
 * when placed.
 *
 * Purely presentational over (a) the `['canvas-layouts', 'root']` query — the
 * SAME key CanvasStage reads, so react-query dedups — and (b) the per-row
 * `['note', id]` query (seeded from the `['notes']` list cache, exactly like
 * NoteCard). It owns NO navigation: the row-interaction callbacks + the current
 * `view` come from {@link ShelfContext}, which App provides around the Dock
 * (Task 10). The §4 row-interaction table:
 *
 *   |              | unplaced row            | placed row          |
 *   | feed view    | click → onGotoNote      | click → onJumpToCard|
 *   | canvas view  | click → onGotoNote;     | click → onJumpToCard|
 *   |              | drag handle → begin     |                     |
 *
 * Rows that switch stages on click carry NO ellipsis marker (the §4 honesty
 * rule — they behave like search hits). Drag-to-place exists only on the canvas
 * view (there is no drop target on the feed); the handle merely emits the begin
 * event — the ghost + drop is Task 6's interaction hook.
 *
 * @see docs/specs/v0.4-canvas-mvp.md §4
 * @see src/renderer/src/canvas/NoteCard.tsx (the ['note', id] seeding idiom)
 */
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { GripVertical } from 'lucide-react'
import { createContext, useContext, useMemo } from 'react'
import { type CanvasLayoutRow, MANUAL_ARRANGEMENT_ID, ROOT_CANVAS_ID } from '../../../shared/canvas'
import type { Note, NoteType } from '../../../shared/types'
import { api } from '../lib/api'
import { noteTitle } from '../lib/note-title'
import { NOTE_TYPE_COLOR, NOTE_TYPE_GLYPH } from '../lib/note-type-glyph'

/** Last-N cap for the "recently placed" group (spec §4). */
const RECENTLY_PLACED_LIMIT = 10

/**
 * The navigation surface the shelf needs but does not own. App provides this
 * value around the Dock (Task 10); the dock passes no props to `render()`, so
 * the pane reads it from context instead.
 */
export interface ShelfContextValue {
  /** Which stage is showing — drives the §4 row-click branch. */
  view: 'feed' | 'canvas'
  /** Go to the note in the feed (scroll + flash); on canvas view this switches to feed. */
  onGotoNote: (id: string) => void
  /** Jump to a placed card (pan/zoom + ring flash); from feed view this switches to canvas. */
  onJumpToCard: (id: string) => void
  /** Begin a place-from-shelf ghost drag (canvas view only). Ghost/drop is Task 6. */
  onBeginShelfDrag: (id: string) => void
}

/**
 * Shelf navigation context. Default value is a feed-view no-op so a stray
 * mount (e.g. a Storybook-style render) doesn't throw — App always overrides it.
 */
export const ShelfContext = createContext<ShelfContextValue>({
  view: 'feed',
  onGotoNote: () => {},
  onJumpToCard: () => {},
  onBeginShelfDrag: () => {},
})

/** Read the shelf navigation context. @see ShelfContext */
export function useShelf(): ShelfContextValue {
  return useContext(ShelfContext)
}

/**
 * One shelf row. Resolves the note via the `['note', id]` query, seeding from
 * the `['notes']` list cache as placeholder (NoteCard's idiom) so the title
 * paints immediately. `placed` flips the ▦ chip + the click target; the drag
 * handle is rendered only on the canvas view for unplaced rows.
 */
function ShelfRow({ noteId, placed }: { noteId: string; placed: boolean }) {
  const queryClient = useQueryClient()
  const { view, onGotoNote, onJumpToCard, onBeginShelfDrag } = useShelf()

  const { data: note } = useQuery({
    queryKey: ['note', noteId],
    queryFn: () => api.notes.get(noteId),
    placeholderData: () =>
      queryClient.getQueryData<Note[]>(['notes'])?.find((n) => n.id === noteId),
  })

  // Title falls back to the id until the note resolves (placeholder-cache miss).
  const title = note ? noteTitle(note) : noteId
  const type: NoteType = note?.type ?? 'claim'
  const handleClick = () => (placed ? onJumpToCard(noteId) : onGotoNote(noteId))

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the row mirrors the feed bubble — mouse-driven at v0.4; keyboard shelf nav is a later milestone.
    // biome-ignore lint/a11y/noStaticElementInteractions: the row is the click target; the drag handle is the only inner button.
    <div
      data-testid={placed ? 'shelf-row-placed' : 'shelf-row-unplaced'}
      onClick={handleClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 8px',
        borderRadius: 'var(--r-3)',
        cursor: 'pointer',
        fontSize: 13,
        color: 'var(--fg-1)',
        fontFamily: 'var(--font-sans)',
      }}
    >
      <span
        aria-hidden="true"
        style={{
          fontSize: 10,
          color: NOTE_TYPE_COLOR[type] ?? 'var(--fg-3)',
          flexShrink: 0,
          width: 12,
          textAlign: 'center',
        }}
      >
        {NOTE_TYPE_GLYPH[type] ?? '●'}
      </span>
      <span
        style={{
          flex: 1,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {title}
      </span>
      {placed && (
        <span
          aria-hidden="true"
          title="on canvas"
          style={{
            fontSize: 10,
            fontFamily: 'var(--font-mono)',
            color: 'var(--fg-3)',
            border: '1px solid var(--border-0)',
            borderRadius: 'var(--r-2)',
            padding: '1px 4px',
            flexShrink: 0,
          }}
        >
          ▦
        </span>
      )}
      {/* Drag-to-place handle — canvas view only (no drop target on the feed).
         Emits the begin event with the note id; the ghost + drop is Task 6. */}
      {!placed && view === 'canvas' && (
        <button
          type="button"
          aria-label={`drag "${title}" to the canvas`}
          title="drag onto the canvas"
          onPointerDown={(e) => {
            e.stopPropagation()
            onBeginShelfDrag(noteId)
          }}
          onClick={(e) => e.stopPropagation()}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            border: 0,
            background: 'transparent',
            color: 'var(--fg-3)',
            cursor: 'grab',
            padding: 0,
            flexShrink: 0,
          }}
        >
          <GripVertical size={14} />
        </button>
      )}
    </div>
  )
}

/** Quiet group heading shared by both shelf sections. */
function GroupHeading({ label }: { label: string }) {
  return (
    <div
      style={{
        padding: '8px 8px 4px',
        fontSize: 11,
        letterSpacing: 0.4,
        textTransform: 'uppercase',
        color: 'var(--fg-3)',
        fontFamily: 'var(--font-sans)',
      }}
    >
      {label}
    </div>
  )
}

/** Shelf pane body — placement queue (spec §4). */
export function ShelfPaneBody(): React.JSX.Element {
  const { data: layouts = [] } = useQuery({
    queryKey: ['canvas-layouts', ROOT_CANVAS_ID],
    queryFn: () =>
      api.canvas.listLayouts({ canvasId: ROOT_CANVAS_ID, arrangementId: MANUAL_ARRANGEMENT_ID }),
  })

  const { toPlace, recentlyPlaced } = useMemo(() => {
    const unplaced: CanvasLayoutRow[] = []
    const placed: CanvasLayoutRow[] = []
    for (const row of layouts) {
      if (row.x === null) unplaced.push(row)
      else placed.push(row)
    }
    // "to place": newest first by created_at desc.
    unplaced.sort((a, b) => b.created_at - a.created_at)
    // "recently placed": last 10 by placed_at desc (nulls sort last).
    placed.sort((a, b) => (b.placed_at ?? 0) - (a.placed_at ?? 0))
    return {
      toPlace: unplaced,
      recentlyPlaced: placed.slice(0, RECENTLY_PLACED_LIMIT),
    }
  }, [layouts])

  const empty = toPlace.length === 0 && recentlyPlaced.length === 0

  return (
    <div data-shelf-pane style={{ display: 'flex', flexDirection: 'column', overflowY: 'auto' }}>
      {empty && (
        <div
          style={{
            padding: 16,
            fontSize: 12,
            color: 'var(--fg-3)',
            fontFamily: 'var(--font-sans)',
            lineHeight: 1.5,
          }}
        >
          nothing on the shelf — drop a note here or use the ▦+ on a bubble.
        </div>
      )}
      {toPlace.length > 0 && (
        <section>
          <GroupHeading label={`to place (${toPlace.length})`} />
          {toPlace.map((row) => (
            <ShelfRow key={row.note_id} noteId={row.note_id} placed={false} />
          ))}
        </section>
      )}
      {recentlyPlaced.length > 0 && (
        <section>
          <GroupHeading label="recently placed" />
          {recentlyPlaced.map((row) => (
            <ShelfRow key={row.note_id} noteId={row.note_id} placed={true} />
          ))}
        </section>
      )}
    </div>
  )
}
