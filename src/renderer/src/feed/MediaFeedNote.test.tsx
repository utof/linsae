/**
 * Component tests for MediaFeedNote — the YouTube video card in the
 * chronological feed. Purely presentational; no IPC or window.api needed.
 *
 * @see src/renderer/src/feed/MediaFeedNote.tsx
 */
import { fireEvent, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { renderWithProviders as render } from '../../../../tests/setup'
import { formatClock } from '../lib/time'
import { MediaFeedNote } from './MediaFeedNote'

const BASE_PROPS = {
  title: 'Serre spectral sequences — lecture 9',
  channel: 'math 232B',
  durationSec: 2240, // 37:20
  thumbnailUrl: 'https://example.com/thumb.jpg',
  noteCount: 12,
  openQuestionCount: 2,
  createdAt: 1737000000000,
  onOpenThread: vi.fn(),
}

describe('MediaFeedNote', () => {
  it('(a) renders the video title', () => {
    render(<MediaFeedNote {...BASE_PROPS} />)
    expect(screen.getByText('Serre spectral sequences — lecture 9')).toBeInTheDocument()
  })

  it('(b) clicking "open video notes" row fires onOpenThread', () => {
    const onOpenThread = vi.fn()
    render(<MediaFeedNote {...BASE_PROPS} onOpenThread={onOpenThread} />)
    fireEvent.click(screen.getByRole('button', { name: /open video notes/i }))
    expect(onOpenThread).toHaveBeenCalledTimes(1)
  })

  it('(c) note count and open-question count render', () => {
    render(<MediaFeedNote {...BASE_PROPS} noteCount={12} openQuestionCount={2} />)
    // Use getAllByText to handle possible multiple matches from duration strings
    expect(screen.getAllByText(/12/).length).toBeGreaterThan(0)
    // Open-question count renders as "2 open" in amber
    expect(screen.getByText(/2 open/i)).toBeInTheDocument()
  })

  it('(d) with thumbnailUrl=null renders dark fallback and NO <img>', () => {
    const { container } = render(<MediaFeedNote {...BASE_PROPS} thumbnailUrl={null} />)
    expect(container.querySelector('img')).toBeNull()
  })

  it('(d) with thumbnailUrl set renders an <img>', () => {
    const { container } = render(
      <MediaFeedNote {...BASE_PROPS} thumbnailUrl="https://example.com/thumb.jpg" />,
    )
    expect(container.querySelector('img')).not.toBeNull()
  })

  it('(e) with durationSec=null no duration text appears', () => {
    render(<MediaFeedNote {...BASE_PROPS} durationSec={null} />)
    // formatClock(2240) = "37:20" — should NOT appear
    expect(screen.queryByText('37:20')).toBeNull()
  })

  it('(e) with durationSec set the formatClock output appears', () => {
    render(<MediaFeedNote {...BASE_PROPS} durationSec={2240} />)
    // formatClock(2240) = "37:20"
    expect(screen.getByText(formatClock(2240))).toBeInTheDocument()
  })

  it('(f) clicking the thumbnail opens the thread', () => {
    const onOpenThread = vi.fn()
    render(<MediaFeedNote {...BASE_PROPS} onOpenThread={onOpenThread} />)
    // The thumbnail is its own button, distinct from the bottom "open video notes" row.
    fireEvent.click(screen.getByRole('button', { name: /open notes for/i }))
    expect(onOpenThread).toHaveBeenCalledTimes(1)
  })

  it('(g) duration is shown once — on the thumbnail chip, not duplicated in the meta line', () => {
    render(<MediaFeedNote {...BASE_PROPS} durationSec={2240} />)
    expect(screen.getAllByText(formatClock(2240))).toHaveLength(1)
  })
})
