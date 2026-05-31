// @vitest-environment jsdom
/**
 * Component tests for the video-order Rail.
 *
 * Builds clusters via the REAL `clusterByPause` over sample items so the
 * cluster/gap geometry under test matches production. Two anchored clusters
 * (t=30 and t=210, a 3-minute gap) plus an anchorless item.
 *
 * Video-mode assertions:
 *   (a) ONE Time label per cluster (a same-pause cluster with 2 notes shows one).
 *   (b) a `rail-gap` element between clusters with style.height === logGapHeight((210-30)/60).
 *   (c) the `anchorless-divider` renders only when anchorless notes exist.
 *   (d) a `rail-playhead` marker is present.
 *   (e) clicking a cluster Dot calls onSeekNote(t).
 * Capture-mode: renders the flat `sorted` list and NO rail-gap / rail-playhead.
 *
 * @see src/renderer/src/thread/Rail.tsx
 * @see docs/specs/v0.2-youtube-annotation.md §ThreadView
 */

import { fireEvent, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { renderWithProviders } from '../../../../tests/setup'
import type { Attachment, Note } from '../../../shared/types'
import { Rail } from './Rail'
import { clusterByPause, logGapHeight } from './rail-layout'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const baseNote = (id: string, t: number | null, overrides: Partial<Note> = {}): Note => ({
  id,
  slug: id,
  body: `body of ${id}`,
  type: 'claim',
  created_at: 1000,
  updated_at: 1000,
  deleted_at: null,
  source_kind: 'youtube',
  source_locator:
    t === null ? { media: 'youtube', video_id: 'v' } : { media: 'youtube', video_id: 'v', t },
  ...overrides,
})

const item = (id: string, t: number | null, attachment: Attachment | null = null) => ({
  id,
  t,
  createdAt: 1000,
  note: baseNote(id, t),
  attachment,
})

// Two same-pause notes at t=30, one note at t=210 (gap 3 min), one anchorless.
const itemsAtThirty = [item('a30-1', 30), item('a30-2', 30)]
const itemAt210 = item('b210', 210)
const anchorlessItem = item('anchorless', null)

const anchored = [...itemsAtThirty, itemAt210]
// clusterByPause accepts { id, t, createdAt } structurally.
const clusters = clusterByPause(anchored as never) as unknown as Array<{
  t: number
  notes: typeof anchored
}>
const sorted = [...anchored, anchorlessItem]

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Rail (video mode)', () => {
  it('(a) renders one Time label per cluster (same-pause cluster shows one)', () => {
    renderWithProviders(
      <Rail
        clusters={clusters}
        anchorless={[anchorlessItem]}
        sorted={sorted}
        mode="video"
        playheadT={42}
        onSeekNote={vi.fn()}
      />,
    )
    // Two clusters → exactly two Time labels (the same-pause cluster collapses to one).
    expect(screen.getAllByTestId('rail-time')).toHaveLength(2)
    expect(screen.getByText('0:30')).toBeInTheDocument()
    expect(screen.getByText('3:30')).toBeInTheDocument()
  })

  it('(b) renders a rail-gap whose height is logGapHeight((210-30)/60)', () => {
    renderWithProviders(
      <Rail
        clusters={clusters}
        anchorless={[anchorlessItem]}
        sorted={sorted}
        mode="video"
        playheadT={42}
        onSeekNote={vi.fn()}
      />,
    )
    const gaps = screen.getAllByTestId('rail-gap')
    expect(gaps).toHaveLength(1)
    expect(gaps[0]?.style.height).toBe(`${logGapHeight((210 - 30) / 60)}px`)
  })

  it('(c) renders the anchorless-divider only when anchorless notes exist', () => {
    const { rerender } = renderWithProviders(
      <Rail
        clusters={clusters}
        anchorless={[anchorlessItem]}
        sorted={sorted}
        mode="video"
        playheadT={42}
        onSeekNote={vi.fn()}
      />,
    )
    expect(screen.getByTestId('anchorless-divider')).toBeInTheDocument()

    rerender(
      <Rail
        clusters={clusters}
        anchorless={[]}
        sorted={anchored}
        mode="video"
        playheadT={42}
        onSeekNote={vi.fn()}
      />,
    )
    expect(screen.queryByTestId('anchorless-divider')).not.toBeInTheDocument()
  })

  it('(d) renders a rail-playhead marker', () => {
    renderWithProviders(
      <Rail
        clusters={clusters}
        anchorless={[anchorlessItem]}
        sorted={sorted}
        mode="video"
        playheadT={42}
        onSeekNote={vi.fn()}
      />,
    )
    expect(screen.getByTestId('rail-playhead')).toBeInTheDocument()
  })

  it('(e) clicking a cluster Dot calls onSeekNote with the cluster t', () => {
    const onSeekNote = vi.fn()
    renderWithProviders(
      <Rail
        clusters={clusters}
        anchorless={[anchorlessItem]}
        sorted={sorted}
        mode="video"
        playheadT={42}
        onSeekNote={onSeekNote}
      />,
    )
    const dots = screen.getAllByTestId('rail-dot')
    // First cluster is t=30.
    fireEvent.click(dots[0] as Element)
    expect(onSeekNote).toHaveBeenCalledWith(30)
  })

  it('renders the screenshot frame for a note with an attachment', () => {
    const attachment: Attachment = {
      id: 'att-1',
      note_id: 'shot',
      kind: 'screenshot',
      base_sha256: 'sha',
      base_path: '/store/2026/05/sha.png',
      overlay_path: null,
      video_id: 'v',
      time_seconds: 30,
      width_px: 1920,
      height_px: 1080,
      device_pixel_ratio: 2,
      created_at: 900,
      deleted_at: null,
    }
    const shotItem = item('shot', 30, attachment)
    const shotClusters = clusterByPause([shotItem] as never) as unknown as typeof clusters
    renderWithProviders(
      <Rail
        clusters={shotClusters}
        anchorless={[]}
        sorted={[shotItem]}
        mode="video"
        playheadT={0}
        onSeekNote={vi.fn()}
      />,
    )
    const img = screen.getByRole('img')
    expect(img.getAttribute('src')).toBe('/_media/2026/05/sha.png')
  })
})

describe('Rail (capture mode)', () => {
  it('renders the flat sorted list with NO rail-gap / rail-playhead', () => {
    renderWithProviders(
      <Rail
        clusters={clusters}
        anchorless={[anchorlessItem]}
        sorted={sorted}
        mode="capture"
        playheadT={42}
        onSeekNote={vi.fn()}
      />,
    )
    // All four notes render as bubbles.
    expect(screen.getByText('body of a30-1')).toBeInTheDocument()
    expect(screen.getByText('body of anchorless')).toBeInTheDocument()
    // No rail geometry in capture mode.
    expect(screen.queryByTestId('rail-gap')).not.toBeInTheDocument()
    expect(screen.queryByTestId('rail-playhead')).not.toBeInTheDocument()
    expect(screen.queryByTestId('rail-dot')).not.toBeInTheDocument()
  })
})
