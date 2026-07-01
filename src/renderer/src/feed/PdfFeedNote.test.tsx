/**
 * Component tests for PdfFeedNote — the PDF document card in the
 * chronological feed. Tests both the presentational layer (PdfFeedNote) and
 * the data container (PdfFeedNoteContainer).
 *
 * @see src/renderer/src/feed/PdfFeedNote.tsx
 * @see src/renderer/src/feed/MediaFeedNote.test.tsx (YouTube analog)
 */
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { installMockApi, renderWithProviders } from '../../../../tests/setup'
import type { Note } from '../../../shared/types'
import { PdfFeedNote, PdfFeedNoteContainer } from './PdfFeedNote'

// Mock usePdfThumbnail so tests do not invoke pdfjs-dist (happy-dom has no
// real canvas renderer). Default: data = undefined (thumbnail pending/absent).
// Individual tests override via vi.mocked(usePdfThumbnail).mockReturnValue().
vi.mock('../pdf/usePdfThumbnail', () => ({
  usePdfThumbnail: vi.fn().mockReturnValue({ data: undefined }),
}))

import { usePdfThumbnail } from '../pdf/usePdfThumbnail'

const noop = () => {}

const pdfDocNote: Note = {
  id: 'doc1',
  slug: 'doc1',
  body: '',
  type: 'source',
  source_kind: 'pdf',
  source_locator: { media: 'pdf', pdf_id: 'p1' },
  created_at: new Date(2026, 5, 1, 14, 23, 0).getTime(),
  updated_at: new Date(2026, 5, 1, 14, 23, 0).getTime(),
  deleted_at: null,
}

describe('PdfFeedNote (presentational)', () => {
  it('(a) renders the "open notes" button unconditionally even when title/pageCount are null', () => {
    renderWithProviders(
      <PdfFeedNote
        title={null}
        pageCount={null}
        noteCount={0}
        openQuestionCount={0}
        createdAt={pdfDocNote.created_at}
        onOpenThread={noop}
      />,
    )
    expect(screen.getByRole('button', { name: /open notes/i })).toBeInTheDocument()
  })

  it('(b) renders a fallback title when title is null', () => {
    renderWithProviders(
      <PdfFeedNote
        title={null}
        pageCount={null}
        noteCount={0}
        openQuestionCount={0}
        createdAt={pdfDocNote.created_at}
        onOpenThread={noop}
      />,
    )
    expect(screen.getByText('PDF Document')).toBeInTheDocument()
  })

  it('(c) renders the provided title', () => {
    renderWithProviders(
      <PdfFeedNote
        title="My Research Paper"
        pageCount={42}
        noteCount={5}
        openQuestionCount={1}
        createdAt={pdfDocNote.created_at}
        onOpenThread={noop}
      />,
    )
    expect(screen.getByText('My Research Paper')).toBeInTheDocument()
  })

  it('(d) page-count chip renders when pageCount is provided', () => {
    renderWithProviders(
      <PdfFeedNote
        title="Paper"
        pageCount={42}
        noteCount={0}
        openQuestionCount={0}
        createdAt={pdfDocNote.created_at}
        onOpenThread={noop}
      />,
    )
    expect(screen.getByText(/42 pages/i)).toBeInTheDocument()
  })

  it('(e) no page-count chip when pageCount is null', () => {
    renderWithProviders(
      <PdfFeedNote
        title="Paper"
        pageCount={null}
        noteCount={0}
        openQuestionCount={0}
        createdAt={pdfDocNote.created_at}
        onOpenThread={noop}
      />,
    )
    expect(screen.queryByText(/pages/i)).toBeNull()
  })

  it('(f) note count and open-question count render in the open-notes row', () => {
    renderWithProviders(
      <PdfFeedNote
        title="Paper"
        pageCount={null}
        noteCount={7}
        openQuestionCount={2}
        createdAt={pdfDocNote.created_at}
        onOpenThread={noop}
      />,
    )
    expect(screen.getByText(/7 notes/)).toBeInTheDocument()
    expect(screen.getByText(/2 open/)).toBeInTheDocument()
  })

  it('(g) open-question count is hidden when zero', () => {
    renderWithProviders(
      <PdfFeedNote
        title="Paper"
        pageCount={null}
        noteCount={3}
        openQuestionCount={0}
        createdAt={pdfDocNote.created_at}
        onOpenThread={noop}
      />,
    )
    // "N open" should not appear; "open notes" (the button label) is always present.
    expect(screen.queryByText(/\d+ open/)).toBeNull()
  })

  it('(h) clicking "open notes" fires onOpenThread', () => {
    const onOpenThread = vi.fn()
    renderWithProviders(
      <PdfFeedNote
        title="Paper"
        pageCount={null}
        noteCount={0}
        openQuestionCount={0}
        createdAt={pdfDocNote.created_at}
        onOpenThread={onOpenThread}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /open notes/i }))
    expect(onOpenThread).toHaveBeenCalledTimes(1)
  })

  it('(i) no hover toolbar when onDelete / onCopyLink are omitted', () => {
    const { container } = renderWithProviders(
      <PdfFeedNote
        title="Paper"
        pageCount={null}
        noteCount={0}
        openQuestionCount={0}
        createdAt={pdfDocNote.created_at}
        onOpenThread={noop}
      />,
    )
    fireEvent.mouseEnter(container.firstChild as Element)
    expect(screen.queryByRole('button', { name: /^delete$/i })).toBeNull()
  })

  it('(j) hover reveals delete; arm-then-confirm fires onDelete once', () => {
    const onDelete = vi.fn()
    const { container } = renderWithProviders(
      <PdfFeedNote
        title="Paper"
        pageCount={null}
        noteCount={0}
        openQuestionCount={0}
        createdAt={pdfDocNote.created_at}
        onOpenThread={noop}
        onDelete={onDelete}
      />,
    )
    expect(screen.queryByRole('button', { name: /^delete$/i })).toBeNull()
    fireEvent.mouseEnter(container.firstChild as Element)
    fireEvent.click(screen.getByRole('button', { name: /^delete$/i }))
    expect(onDelete).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /confirm delete/i }))
    expect(onDelete).toHaveBeenCalledTimes(1)
  })

  it('(k) shows a post time, time-of-day only (no date)', () => {
    renderWithProviders(
      <PdfFeedNote
        title="Paper"
        pageCount={null}
        noteCount={0}
        openQuestionCount={0}
        createdAt={pdfDocNote.created_at}
        onOpenThread={noop}
      />,
    )
    expect(screen.getByText(/2:23/)).toBeInTheDocument()
  })

  it('(l) clicking the document title fires onOpenReader without firing onOpenThread (#168)', () => {
    const onOpenReader = vi.fn()
    const onOpenThread = vi.fn()
    renderWithProviders(
      <PdfFeedNote
        title="Research Paper"
        pageCount={null}
        noteCount={0}
        openQuestionCount={0}
        createdAt={pdfDocNote.created_at}
        onOpenThread={onOpenThread}
        onOpenReader={onOpenReader}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Research Paper' }))
    expect(onOpenReader).toHaveBeenCalledTimes(1)
    expect(onOpenThread).not.toHaveBeenCalled()
  })

  it('(m) "open notes" button fires onOpenThread and NOT onOpenReader (#168)', () => {
    const onOpenReader = vi.fn()
    const onOpenThread = vi.fn()
    renderWithProviders(
      <PdfFeedNote
        title="Research Paper"
        pageCount={null}
        noteCount={0}
        openQuestionCount={0}
        createdAt={pdfDocNote.created_at}
        onOpenThread={onOpenThread}
        onOpenReader={onOpenReader}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /open notes/i }))
    expect(onOpenThread).toHaveBeenCalledTimes(1)
    expect(onOpenReader).not.toHaveBeenCalled()
  })
})

describe('PdfFeedNoteContainer', () => {
  beforeEach(() => {
    const mock = installMockApi()
    mock.pdf.open.mockResolvedValue({
      pdfId: 'p1',
      sha256: 'abc',
      title: 'Loaded Title',
      pageCount: 12,
      mediaUrl: '/_media/p1.pdf',
    })
    mock.links.commentsOf.mockResolvedValue([])
  })

  it('renders the "open notes" button immediately (before metadata resolves)', () => {
    renderWithProviders(<PdfFeedNoteContainer note={pdfDocNote} />)
    // Button is present before any async data resolves because PdfFeedNote
    // renders it unconditionally — null metadata shows the fallback title.
    expect(screen.getByRole('button', { name: /open notes/i })).toBeInTheDocument()
  })

  it('renders the resolved title and pageCount once metadata arrives', async () => {
    renderWithProviders(<PdfFeedNoteContainer note={pdfDocNote} />)
    await waitFor(() => {
      expect(screen.getByText('Loaded Title')).toBeInTheDocument()
    })
    expect(screen.getByText(/12 pages/i)).toBeInTheDocument()
  })

  it('calls onOpenThread with note.id when "open notes" is clicked', async () => {
    const onOpenThread = vi.fn()
    renderWithProviders(<PdfFeedNoteContainer note={pdfDocNote} onOpenThread={onOpenThread} />)
    await waitFor(() => expect(screen.getByText('Loaded Title')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /open notes/i }))
    expect(onOpenThread).toHaveBeenCalledWith('doc1')
  })

  it('clicking the document title calls onOpenReader with the pdf_id (#168)', async () => {
    const onOpenReader = vi.fn()
    renderWithProviders(<PdfFeedNoteContainer note={pdfDocNote} onOpenReader={onOpenReader} />)
    await waitFor(() => expect(screen.getByText('Loaded Title')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'Loaded Title' }))
    expect(onOpenReader).toHaveBeenCalledWith('p1')
  })

  it('thumbnail from usePdfThumbnail is rendered in the card (#167)', async () => {
    vi.mocked(usePdfThumbnail).mockReturnValue({
      data: 'data:image/jpeg;base64,/9j/thumbnaildata',
    } as ReturnType<typeof usePdfThumbnail>)
    renderWithProviders(<PdfFeedNoteContainer note={pdfDocNote} />)
    await waitFor(() => {
      const img = screen.getByRole('img')
      expect(img).toHaveAttribute('src', 'data:image/jpeg;base64,/9j/thumbnaildata')
    })
    // Restore default mock for subsequent tests.
    vi.mocked(usePdfThumbnail).mockReturnValue({ data: undefined } as ReturnType<
      typeof usePdfThumbnail
    >)
  })
})

describe('PdfFeedNote (presentational) — thumbnail (#167)', () => {
  it('(n) renders a thumbnail <img> when thumbnailDataUrl is provided', () => {
    renderWithProviders(
      <PdfFeedNote
        title="Paper"
        pageCount={null}
        noteCount={0}
        openQuestionCount={0}
        createdAt={pdfDocNote.created_at}
        onOpenThread={noop}
        thumbnailDataUrl="data:image/jpeg;base64,/9j/test"
      />,
    )
    const img = screen.getByRole('img')
    expect(img).toHaveAttribute('src', 'data:image/jpeg;base64,/9j/test')
  })

  it('(o) no <img> when thumbnailDataUrl is null (FileText glyph shows via header)', () => {
    renderWithProviders(
      <PdfFeedNote
        title="Paper"
        pageCount={null}
        noteCount={0}
        openQuestionCount={0}
        createdAt={pdfDocNote.created_at}
        onOpenThread={noop}
        thumbnailDataUrl={null}
      />,
    )
    expect(screen.queryByRole('img')).toBeNull()
  })

  it('(p) clicking the thumbnail strip fires onOpenReader and NOT onOpenThread (#167)', () => {
    const onOpenReader = vi.fn()
    const onOpenThread = vi.fn()
    renderWithProviders(
      <PdfFeedNote
        title="Paper"
        pageCount={null}
        noteCount={0}
        openQuestionCount={0}
        createdAt={pdfDocNote.created_at}
        onOpenThread={onOpenThread}
        onOpenReader={onOpenReader}
        thumbnailDataUrl="data:image/jpeg;base64,/9j/test"
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'open in pdf reader' }))
    expect(onOpenReader).toHaveBeenCalledTimes(1)
    expect(onOpenThread).not.toHaveBeenCalled()
  })
})
