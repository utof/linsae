import { useQuery } from '@tanstack/react-query'
import { ChevronRight, FileText, Link2, MessagesSquare, Trash2 } from 'lucide-react'
import { type MouseEvent, useEffect, useRef, useState } from 'react'
import type { Note } from '../../../shared/types'
import { api } from '../lib/api'
import { useClock24 } from '../lib/clock-pref'
import { formatTimeOnly } from '../lib/wallclock'
import { useThreadNotes } from '../thread/useThreadNotes'
import { type ContextMenuPos, NoteContextMenu } from './ContextMenu'

/**
 * Presentational props for the PDF document card in the chronological feed.
 * Mirrors MediaFeedNoteProps (YouTube analog) — title/count chip/open-notes row.
 *
 * The "open notes" button is always rendered regardless of metadata load state so
 * the user can access the thread even before api.pdf.open resolves.
 *
 * @see src/renderer/src/feed/MediaFeedNote.tsx (YouTube analog)
 * @see docs/specs/v0.6.4-notes-as-threads.md §Feed card
 */
export interface PdfFeedNoteProps {
  /** PDF title from pdf_documents.title; null while loading or when unavailable. */
  title: string | null
  /**
   * Total page count from pdf_documents.page_count (API field: pageCount); null when loading.
   * Why pageCount (camelCase): api.pdf.open returns { pageCount } per src/renderer/src/lib/api.ts:168.
   */
  pageCount: number | null
  /** Total comment-note count derived from useThreadNotes('capture'). */
  noteCount: number
  /**
   * Notes with type === 'question' (all open at v0.6.4; no resolved state in schema yet).
   * Why: spec line 111 reuses v0.1 question/status semantics; v0.1 never shipped resolved state.
   */
  openQuestionCount: number
  /** Wall-clock epoch ms — shown as time-of-day only (feed day divider carries the date). */
  createdAt: number
  /** Called when the user activates the "open notes" affordance. */
  onOpenThread: () => void
  /**
   * Hover-toolbar actions (parity with MediaFeedNote). `edit` is absent — a source note
   * has no editable body; you annotate inside the thread, not on the card.
   */
  onDelete?: () => void
  onCopyLink?: () => void
}

/**
 * Data container for a PDF document-level source note in the feed.
 * Fetches title/pageCount via api.pdf.open and derives counts from
 * useThreadNotes(note.id, 'capture'), then renders a PdfFeedNote card.
 *
 * Why a separate container (not inline in NoteBubble): the query + hook coupling
 * lives here so NoteBubble stays a thin dispatcher (same pattern as
 * MediaFeedNoteContainer for YouTube notes).
 *
 * Why 'capture' sortMode: PDF threads are timestamp-agnostic (no video playhead);
 * capture order (createdAt) is the natural ordering. Per useThreadNotes.ts:90.
 *
 * @see src/renderer/src/feed/MediaFeedNote.tsx (MediaFeedNoteContainer — YouTube analog)
 * @see src/renderer/src/feed/NoteBubble.tsx (isPdfDoc branch)
 * @see docs/specs/v0.6.4-notes-as-threads.md §Feed card
 */
export function PdfFeedNoteContainer({
  note,
  onOpenThread,
  onDelete,
  onCopyLink,
}: {
  note: Note
  onOpenThread?: (id: string) => void
  onDelete?: () => void
  onCopyLink?: () => void
}) {
  const pdfId = note.source_locator?.media === 'pdf' ? note.source_locator.pdf_id : ''
  const { data: meta } = useQuery({
    queryKey: ['pdfMeta', pdfId],
    queryFn: () => api.pdf.open(pdfId),
    enabled: !!pdfId,
  })
  const { noteCount, openQuestionCount } = useThreadNotes(note.id, 'capture')
  return (
    <PdfFeedNote
      title={meta?.title ?? null}
      pageCount={meta?.pageCount ?? null}
      noteCount={noteCount}
      openQuestionCount={openQuestionCount}
      createdAt={note.created_at}
      onOpenThread={() => onOpenThread?.(note.id)}
      {...(onDelete ? { onDelete } : {})}
      {...(onCopyLink ? { onCopyLink } : {})}
    />
  )
}

/**
 * Presentational card for a PDF document-level source note in the chronological feed.
 * Variant mirrors MediaFeedNote (YouTube analog): title + page-count chip + note/question
 * counts + an accent "open notes" button in a hairline-topped bottom row.
 *
 * Why "open notes" (not "open pdf notes"): the button triggers the generic ThreadView
 * (Task 2.3) which works for any media kind; keeping the label generic avoids
 * media-specific variants in the button text.
 *
 * The "open notes" button is rendered unconditionally — even while metadata is
 * loading — so the user can access the thread from the first render frame.
 * Null metadata shows a "PDF Document" fallback title and hides the page-count chip.
 *
 * @see src/renderer/src/feed/MediaFeedNote.tsx (MediaFeedNote — YouTube analog)
 * @see docs/specs/v0.6.4-notes-as-threads.md §Feed card
 */
export function PdfFeedNote({
  title,
  pageCount,
  noteCount,
  openQuestionCount,
  createdAt,
  onOpenThread,
  onDelete,
  onCopyLink,
}: PdfFeedNoteProps) {
  const clock24 = useClock24()
  const [hover, setHover] = useState(false)
  const [contextMenu, setContextMenu] = useState<ContextMenuPos | null>(null)
  // Two-click delete arm, mirroring NoteBubble/MediaFeedNote: deleting a PDF card
  // removes the whole source note, so a single misclick shouldn't nuke it.
  const [deleteArmed, setDeleteArmed] = useState(false)
  const armTimer = useRef<number | null>(null)

  // Clear a pending arm timer on unmount so it can't setState a virtualised-out card.
  useEffect(
    () => () => {
      if (armTimer.current !== null) clearTimeout(armTimer.current)
    },
    [],
  )

  const showToolbar = hover && (onDelete != null || onCopyLink != null)

  const handleTrashClick = (e: MouseEvent) => {
    e.stopPropagation()
    if (deleteArmed) {
      if (armTimer.current !== null) clearTimeout(armTimer.current)
      setDeleteArmed(false)
      onDelete?.()
      return
    }
    setDeleteArmed(true)
    armTimer.current = window.setTimeout(() => setDeleteArmed(false), 2000)
  }

  // Fallback title while metadata is loading or when pdf_documents.title is NULL.
  const displayTitle = title ?? 'PDF Document'

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the card root only tracks hover to reveal the action toolbar; the actionable targets are the inner <button>s (open-notes / copy / delete).
    <div
      // data-bubble: exclusion-selector parity with text bubbles and MediaFeedNote —
      // the drag hook and gutter right-click handler use closest('[data-bubble]') to
      // skip presses/right-clicks ON a card.
      data-bubble
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => {
        setHover(false)
        setDeleteArmed(false)
      }}
      onContextMenu={
        onDelete && onCopyLink
          ? (e) => {
              e.preventDefault()
              setContextMenu({ x: e.clientX, y: e.clientY })
            }
          : undefined
      }
      style={{
        position: 'relative',
        maxWidth: 360,
        background: 'var(--bg-0)',
        border: '1px solid var(--border-0)',
        borderRadius: 'var(--r-4)',
        overflow: 'hidden',
        fontFamily: 'var(--font-sans)',
      }}
    >
      {/* Header: file icon + title + page-count chip + post time.
          No thumbnail (PDFs have no video frame); the icon provides quick
          media-type identification at a glance. */}
      <div style={{ padding: 'var(--space-5) var(--space-4) var(--space-4)' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
          <FileText size={18} color="var(--fg-2)" style={{ flexShrink: 0, marginTop: 1 }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                fontSize: 14,
                fontWeight: 500,
                color: 'var(--fg-0)',
                lineHeight: 'var(--lh-snug)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {displayTitle}
            </div>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                marginTop: 4,
              }}
            >
              {/* Page-count chip — only when pageCount is known (populated on first open).
                  Dark pill matches MediaFeedNote's duration chip style. */}
              {pageCount != null && (
                <span
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 10,
                    color: '#fff',
                    background: 'rgba(0,0,0,0.52)',
                    padding: '1px 5px',
                    borderRadius: 3,
                  }}
                >
                  {pageCount} pages
                </span>
              )}
              {/* Post time: time-of-day only (feed day dividers carry the date). */}
              <span
                style={{
                  fontSize: 11,
                  color: 'var(--fg-3)',
                  whiteSpace: 'nowrap',
                  marginLeft: 'auto',
                }}
              >
                {formatTimeOnly(createdAt, !clock24)}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Hairline-topped bottom row — "open notes" thread button.
          Always rendered so the user can access the thread even while metadata loads.
          aria-label "open notes" (not "open pdf notes") matches the generic ThreadView. */}
      <button
        type="button"
        aria-label="open notes"
        onClick={onOpenThread}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          width: '100%',
          cursor: 'pointer',
          border: 0,
          borderTop: '1px solid var(--border-0)',
          background: 'transparent',
          padding: '10px 12px',
          fontFamily: 'var(--font-sans)',
        }}
      >
        <MessagesSquare size={16} color="var(--accent)" />
        <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--accent)' }}>open notes</span>
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 12, color: 'var(--fg-2)', whiteSpace: 'nowrap' }}>
          {noteCount} notes
          {openQuestionCount > 0 ? (
            <>
              {' · '}
              <span style={{ color: 'var(--type-question)' }}>{openQuestionCount} open</span>
            </>
          ) : null}
        </span>
        <ChevronRight size={15} color="var(--fg-3)" />
      </button>

      {/* Hover toolbar — copy-link + arm-to-confirm delete. Positioned INSIDE the
          card (top:6) rather than NoteBubble's top:-10 because the card root is
          overflow:hidden (to clip header corners), which would clip an outset bar.
          Mirrors MediaFeedNote's hover toolbar exactly. */}
      {showToolbar && (
        // biome-ignore lint/a11y/noStaticElementInteractions: wrapper only stops click propagation to the card; the real targets are the inner <button>s.
        // biome-ignore lint/a11y/useKeyWithClickEvents: inner buttons own keyboard activation; the wrapper has no keyboard semantics.
        <div
          onClick={(e) => e.stopPropagation()}
          style={{
            position: 'absolute',
            top: 6,
            right: 6,
            display: 'flex',
            gap: 2,
            background: '#fff',
            border: '1px solid var(--border-0)',
            borderRadius: 4,
            padding: 2,
            boxShadow: 'var(--shadow-1)',
          }}
        >
          {onCopyLink && (
            <button
              type="button"
              title="copy link"
              aria-label="copy link"
              onClick={(e) => {
                e.stopPropagation()
                onCopyLink()
              }}
              style={{ border: 0, background: 'transparent', cursor: 'pointer', padding: 4 }}
            >
              <Link2 size={14} />
            </button>
          )}
          {onDelete && (
            <button
              type="button"
              title="delete pdf"
              aria-label={deleteArmed ? 'confirm delete' : 'delete'}
              onClick={handleTrashClick}
              style={{
                border: 0,
                background: deleteArmed ? '#FDECEC' : 'transparent',
                cursor: 'pointer',
                padding: 4,
                color: deleteArmed ? '#E5484D' : 'inherit',
              }}
            >
              <Trash2 size={14} />
            </button>
          )}
        </div>
      )}

      {/* Right-click menu — same shared component as MediaFeedNote (copy + delete;
          no edit on a source card). Portaled to body, so the card's overflow:hidden
          and the feed's transformed wrapper don't clip / mis-place it. */}
      {contextMenu && onCopyLink && onDelete && (
        <NoteContextMenu
          pos={contextMenu}
          onCopyLink={onCopyLink}
          onDelete={onDelete}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  )
}
