/**
 * A single note card rendered on the canvas. Absolutely positioned in world
 * space via CSS `transform: translate(x, y)`. Supports:
 *   - motion-LOD: renders a title + skeleton placeholder while the camera is
 *     moving and the card has never shown full content; upgrades to full
 *     Markdown once idle. Once upgraded, never demotes (react-markdown
 *     re-parses on every mount, so demotion would waste work and flash content).
 *   - keep-alive hiding: when `keptAlive` is true the card is mounted but
 *     `display: none` — callers keep recently-exited cards alive so the
 *     Markdown parse result survives a brief pan-out and pan-back.
 *   - ResizeObserver: reports shell height changes up via `onMeasured` so the
 *     spatial index stays current.
 *
 * Why no `content-visibility`: spec product decision 6 bans it on canvas
 * surfaces. Keep-alive hiding uses `display: none` exclusively.
 *
 * @see docs/specs/v0.4-canvas-mvp.md §3 (motion-LOD, keep-alive, culling)
 * @see src/renderer/src/canvas/CanvasStage.tsx
 */
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { memo, useEffect, useRef, useState } from 'react'
import type { Note } from '../../../shared/types'
import { api } from '../lib/api'
import { Markdown } from '../lib/markdown'
import { noteTitle } from '../lib/note-title'

export interface NoteCardProps {
  noteId: string
  x: number
  y: number
  /** keep-alive: true → display:none (culled but recently visible) */
  keptAlive: boolean
  /** camera in motion → show placeholder if card not yet upgraded */
  isMoving: boolean
  onMeasured: (noteId: string, height: number) => void
  onWikilinkClick: (slug: string) => void
  resolveSlug: (slug: string) => boolean
  /** Called on double-click to begin in-place editing (spec §3). */
  onBeginEdit: (noteId: string) => void
  /**
   * True while this card is being edited in place: the shell stays mounted (so
   * its ResizeObserver-measured height survives) but `visibility: hidden` so the
   * floating Composer rendered over it by CanvasStage is the only visible layer.
   * @see docs/specs/v0.4-canvas-mvp.md §3 (card editing)
   */
  editing: boolean
}

/** Width of every canvas card in world px (spec §3). */
const CARD_WIDTH = 360
/** Max visible body height before fade truncation (spec §3). */
const CARD_MAX_BODY_HEIGHT = 280
/** Gradient fade height at the bottom of the body when truncated. */
const FADE_HEIGHT = 36

/**
 * Note card for the canvas. Memo'd so it only re-renders when its own props
 * change — the camera changes every frame while panning, but cards are not
 * re-positioned via props; only `isMoving` changes per-card on settle.
 *
 * @see NoteCardProps
 */
export const NoteCard = memo(function NoteCard({
  noteId,
  x,
  y,
  keptAlive,
  isMoving,
  onMeasured,
  onWikilinkClick,
  resolveSlug,
  onBeginEdit,
  editing,
}: NoteCardProps) {
  const queryClient = useQueryClient()

  /**
   * Fetch the note. Seeds from the list cache as a placeholder so the card
   * renders immediately from the already-loaded feed data.
   * Why placeholderData (not initialData): placeholder still triggers a fetch
   * (the list cache caps at 500 and may carry a stale body); initialData would
   * suppress the refetch.
   * api.notes.get is POSITIONAL: api.notes.get(id) → window.api.notes.get({ id })
   * @see src/renderer/src/lib/api.ts:50
   */
  const { data: note } = useQuery({
    queryKey: ['note', noteId],
    queryFn: () => api.notes.get(noteId),
    placeholderData: () =>
      queryClient.getQueryData<Note[]>(['notes'])?.find((n) => n.id === noteId),
  })

  /**
   * Once a card has rendered full Markdown, never demote back to the placeholder.
   * Why a ref (not state): upgrading never requires a re-render by itself; the
   * next isMoving→false render will promote. Tracking via ref avoids a spurious
   * extra render on upgrade.
   */
  const upgradedRef = useRef(false)
  const showFull = !isMoving || upgradedRef.current
  if (showFull) upgradedRef.current = true

  // ---- ResizeObserver: report measured shell height to CanvasStage so the
  // spatial index stays accurate. happy-dom: ResizeObserver never fires in
  // tests; onMeasured will not be called from tests.
  const shellRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = shellRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const h = entries[0]?.contentRect.height
      if (h !== undefined && h > 0) onMeasured(noteId, h)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [noteId, onMeasured])

  // Track whether body is overflowing to show the bottom fade gradient.
  // Approximated: if note body is non-trivial, the card will likely overflow
  // its max-height; we reveal the fade whenever the body wrapper is at max.
  const bodyRef = useRef<HTMLDivElement>(null)
  const [overflows, setOverflows] = useState(false)
  useEffect(() => {
    const el = bodyRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      setOverflows(el.scrollHeight > el.clientHeight)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: canvas cards are spatial objects; double-click to edit is the only interaction, and adding role="button" would misrepresent the card's nature as a spatial container (not a button)
    <div
      ref={shellRef}
      onDoubleClick={() => onBeginEdit(noteId)}
      style={{
        display: keptAlive ? 'none' : undefined,
        // editing → keep mounted (ResizeObserver height persists) but invisible;
        // the floating Composer rendered over it by CanvasStage is what shows.
        visibility: editing ? 'hidden' : undefined,
        position: 'absolute',
        transform: `translate(${x}px, ${y}px)`,
        width: CARD_WIDTH,
        background: '#FFFFFF',
        border: '1px solid var(--border-1)',
        borderRadius: 'var(--r-3)',
        boxSizing: 'border-box',
        padding: '12px 14px 10px',
      }}
    >
      {!note ? (
        // Loading skeleton before any data (list cache miss + fetch in-flight)
        <Placeholder title="…" />
      ) : showFull ? (
        // Full content: body wrapper with max-height + bottom fade when truncated
        <div
          ref={bodyRef}
          style={{
            maxHeight: CARD_MAX_BODY_HEIGHT,
            overflow: 'hidden',
            position: 'relative',
          }}
        >
          <Markdown body={note.body} onWikilinkClick={onWikilinkClick} resolveSlug={resolveSlug} />
          {overflows && (
            <div
              aria-hidden="true"
              style={{
                position: 'absolute',
                bottom: 0,
                left: 0,
                right: 0,
                height: FADE_HEIGHT,
                background: 'linear-gradient(transparent, #FFFFFF)',
                pointerEvents: 'none',
              }}
            />
          )}
        </div>
      ) : (
        // Motion-LOD placeholder: title + two skeleton bars (no Markdown work)
        <Placeholder title={noteTitle(note)} />
      )}
    </div>
  )
})

/**
 * Skeleton placeholder shown during motion-LOD (camera moving, not yet upgraded).
 * Renders a title one-liner and two grey bars — no Markdown/KaTeX work.
 * @see docs/specs/v0.4-canvas-mvp.md §3 motion-LOD
 */
function Placeholder({ title }: { title: string }) {
  return (
    <>
      <div
        style={{
          fontWeight: 600,
          fontSize: 14,
          lineHeight: '1.4',
          color: 'var(--text-1)',
          marginBottom: 8,
          overflow: 'hidden',
          whiteSpace: 'nowrap',
          textOverflow: 'ellipsis',
        }}
      >
        {title}
      </div>
      <div
        aria-hidden="true"
        style={{
          height: 10,
          background: 'var(--bg-2, #e5e7eb)',
          borderRadius: 4,
          marginBottom: 6,
          width: '80%',
        }}
      />
      <div
        aria-hidden="true"
        style={{
          height: 10,
          background: 'var(--bg-2, #e5e7eb)',
          borderRadius: 4,
          width: '55%',
        }}
      />
    </>
  )
}
