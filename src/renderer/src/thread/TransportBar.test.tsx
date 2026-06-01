import type { PlayerState } from '@shared/player'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { TransportBar } from './TransportBar'

// Pure presentational component — no QueryClient or window.api needed.

function makeProps(overrides: Partial<Parameters<typeof TransportBar>[0]> = {}) {
  return {
    state: 'paused' as PlayerState,
    currentTime: 83,
    duration: 3723,
    rate: 1,
    markers: [30, 90],
    followOn: false,
    onPlayPause: vi.fn(),
    onSeek: vi.fn(),
    onRate: vi.fn(),
    onToggleFollow: vi.fn(),
    onFullscreen: vi.fn(),
    ...overrides,
  }
}

describe('TransportBar', () => {
  it('formats currentTime and duration with formatClock', () => {
    // 83 s → 1:23 ; 3723 s → 1:02:03
    render(<TransportBar {...makeProps()} />)
    const timeEl = screen.getByTestId('transport-time')
    expect(timeEl.textContent).toContain('1:23')
    expect(timeEl.textContent).toContain('1:02:03')
  })

  it('shows Play button when state is paused', () => {
    render(<TransportBar {...makeProps({ state: 'paused' })} />)
    expect(screen.getByRole('button', { name: /^play$/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^pause$/i })).toBeNull()
  })

  it('shows Pause button when state is playing', () => {
    render(<TransportBar {...makeProps({ state: 'playing' })} />)
    expect(screen.getByRole('button', { name: /^pause$/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^play$/i })).toBeNull()
  })

  it('clicking play/pause calls onPlayPause', () => {
    const onPlayPause = vi.fn()
    render(<TransportBar {...makeProps({ onPlayPause })} />)
    fireEvent.click(screen.getByRole('button', { name: /^play$/i }))
    expect(onPlayPause).toHaveBeenCalledOnce()
  })

  it('follow button has no accent style when followOn=false', () => {
    render(<TransportBar {...makeProps({ followOn: false })} />)
    const btn = screen.getByRole('button', { name: /follow playback/i })
    expect(btn.dataset.active).toBe('false')
  })

  it('follow button carries accent treatment when followOn=true', () => {
    render(<TransportBar {...makeProps({ followOn: true })} />)
    const btn = screen.getByRole('button', { name: /follow playback/i })
    expect(btn.dataset.active).toBe('true')
  })

  it('clicking follow button calls onToggleFollow', () => {
    const onToggleFollow = vi.fn()
    render(<TransportBar {...makeProps({ onToggleFollow })} />)
    fireEvent.click(screen.getByRole('button', { name: /follow playback/i }))
    expect(onToggleFollow).toHaveBeenCalledOnce()
  })

  it('renders exactly two marker ticks', () => {
    render(<TransportBar {...makeProps({ markers: [30, 90] })} />)
    expect(screen.getAllByTestId('scrubber-marker')).toHaveLength(2)
  })

  it('renders zero marker ticks when markers array is empty', () => {
    render(<TransportBar {...makeProps({ markers: [] })} />)
    expect(screen.queryAllByTestId('scrubber-marker')).toHaveLength(0)
  })

  it('shows rate badge with onRate callback', () => {
    const onRate = vi.fn()
    render(<TransportBar {...makeProps({ rate: 1.5, onRate })} />)
    const speedBtn = screen.getByRole('button', { name: /playback speed/i })
    expect(speedBtn.textContent).toContain('1.5')
    fireEvent.click(speedBtn)
    expect(onRate).toHaveBeenCalledOnce()
  })

  it('clicking fullscreen calls onFullscreen', () => {
    const onFullscreen = vi.fn()
    render(<TransportBar {...makeProps({ onFullscreen })} />)
    fireEvent.click(screen.getByRole('button', { name: /fullscreen/i }))
    expect(onFullscreen).toHaveBeenCalledOnce()
  })

  it('scrubber track wires onSeek (click handler is attached)', () => {
    const onSeek = vi.fn()
    render(<TransportBar {...makeProps({ onSeek })} />)
    // In jsdom getBoundingClientRect() → zeros, so fraction=0 → seekTo(0).
    // The test just verifies the handler fires on click.
    const track = screen.getByTestId('scrubber-track')
    fireEvent.click(track)
    expect(onSeek).toHaveBeenCalledOnce()
  })

  it('clicking a marker tick seeks to that marker exactly once (stopPropagation)', () => {
    const onSeek = vi.fn()
    render(<TransportBar {...makeProps({ markers: [30, 90], onSeek })} />)
    const ticks = screen.getAllByTestId('scrubber-marker')
    // First tick carries t=30; click must seek to 30 AND not bubble to the
    // track's general click-seek (so exactly one call, with the marker's t).
    fireEvent.click(ticks[0] as Element)
    expect(onSeek).toHaveBeenCalledTimes(1)
    expect(onSeek).toHaveBeenCalledWith(30)
  })
})
