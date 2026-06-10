// @vitest-environment happy-dom
/**
 * Tests for ReopenEditor — the reopen-a-posted-screenshot wrapper.
 *
 * ReopenEditor fetches the saved scene (useOverlayScene) and mounts the editor
 * on it; an empty `overlay_path` → empty scene. On Done it rewrites the sidecar
 * (saveOverlay, inside the editor) and then invalidates the commentsOf query
 * (`['thread', noteId]`) so the Rail re-reads the new `overlay_path` and renders
 * the drawing immediately (B-4 null→path invalidation).
 *
 * @see src/renderer/src/annotate/ReopenEditor.tsx
 * @see docs/specs/v0.2.5-screenshot-annotation.md §"Reopen a posted screenshot"
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { installMockApi, type MockApi } from '../../../../tests/setup'
import type { Attachment } from '../../../shared/types'
import { serializeScene } from '../ink/svg'
import { ReopenEditor } from './ReopenEditor'

const ATTACHMENT_NO_OVERLAY: Attachment = {
  id: 'att-001',
  note_id: 'note-001',
  kind: 'screenshot',
  base_sha256: 'abcdef',
  base_path: '/store/2026/05/abcdef.png',
  overlay_path: null,
  video_id: 'vid1',
  time_seconds: 42,
  width_px: 1920,
  height_px: 1080,
  device_pixel_ratio: 1,
  created_at: 1000,
  deleted_at: null,
}

const ATTACHMENT_WITH_OVERLAY: Attachment = {
  ...ATTACHMENT_NO_OVERLAY,
  overlay_path: '/store/2026/05/att-001.svg',
}

const SAVED_SVG = serializeScene({
  width: 1920,
  height: 1080,
  elements: [
    {
      id: 'pre-1',
      kind: 'stroke',
      points: [
        { x: 1, y: 1, pressure: 0.5 },
        { x: 2, y: 2, pressure: 0.5 },
        { x: 3, y: 3, pressure: 0.5 },
        { x: 4, y: 4, pressure: 0.5 },
      ],
      color: '#0D99FF',
      size: 8,
      simulatePressure: false,
    },
  ],
})

function drawStroke(svg: Element): void {
  fireEvent.pointerDown(svg, { clientX: 10, clientY: 10, pointerType: 'mouse', pressure: 0.5 })
  fireEvent.pointerMove(svg, { clientX: 20, clientY: 22, pointerType: 'mouse', pressure: 0.5 })
  fireEvent.pointerMove(svg, { clientX: 44, clientY: 50, pointerType: 'mouse', pressure: 0.5 })
  fireEvent.pointerUp(svg, { clientX: 44, clientY: 50, pointerType: 'mouse', pressure: 0.5 })
}

function renderReopen(node: React.ReactElement): { qc: QueryClient } {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>)
  return { qc }
}

describe('ReopenEditor', () => {
  let mockApi: MockApi

  beforeEach(() => {
    mockApi = installMockApi()
    mockApi.youtube.saveOverlay.mockResolvedValue({ overlayPath: '/store/2026/05/att-001.svg' })
  })

  it('opens the editor on the parsed saved scene (existing strokes render)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(SAVED_SVG, { status: 200 }))
    renderReopen(
      <ReopenEditor attachment={ATTACHMENT_WITH_OVERLAY} noteId="v1" onClose={vi.fn()} />,
    )
    await waitFor(() => {
      const svg = document.querySelector('svg[aria-label="Annotation overlay"]')
      expect(svg?.querySelectorAll('path').length).toBe(1)
    })
  })

  it('opens an empty editor when overlay_path is null (no fetch needed)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    renderReopen(<ReopenEditor attachment={ATTACHMENT_NO_OVERLAY} noteId="v1" onClose={vi.fn()} />)
    await waitFor(() => {
      expect(document.querySelector('svg[aria-label="Annotation overlay"]')).not.toBeNull()
    })
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(document.querySelectorAll('svg[aria-label="Annotation overlay"] path').length).toBe(0)
  })

  it('Done rewrites the sidecar AND invalidates [thread, noteId] (B-4 null→path)', async () => {
    // First annotation of a posted screenshot: overlay_path starts null.
    const { qc } = renderReopen(
      <ReopenEditor attachment={ATTACHMENT_NO_OVERLAY} noteId="v1" onClose={vi.fn()} />,
    )
    // Seed the commentsOf cache entry so we can assert it gets invalidated.
    qc.setQueryData(['thread', 'v1'], [{ note: {}, attachment: ATTACHMENT_NO_OVERLAY }])

    await waitFor(() =>
      expect(document.querySelector('svg[aria-label="Annotation overlay"]')).not.toBeNull(),
    )
    drawStroke(document.querySelector('svg[aria-label="Annotation overlay"]') as Element)
    fireEvent.click(screen.getByRole('button', { name: /^done$/i }))

    await waitFor(() => expect(mockApi.youtube.saveOverlay).toHaveBeenCalled())
    // The commentsOf query for this thread must be invalidated so the Rail
    // re-reads the new overlay_path and renders the drawing immediately.
    await waitFor(() => {
      expect(qc.getQueryState(['thread', 'v1'])?.isInvalidated).toBe(true)
    })
  })

  it('Done on an emptied scene (all erased) clears the overlay (saveOverlay null)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(SAVED_SVG, { status: 200 }))
    renderReopen(
      <ReopenEditor attachment={ATTACHMENT_WITH_OVERLAY} noteId="v1" onClose={vi.fn()} />,
    )
    // Wait for the saved scene (1 stroke) to load.
    await waitFor(() => {
      const svg = document.querySelector('svg[aria-label="Annotation overlay"]')
      expect(svg?.querySelectorAll('path').length).toBe(1)
    })
    // Erase the stroke.
    fireEvent.click(screen.getByRole('button', { name: /eraser/i }))
    const path = document.querySelector('svg[aria-label="Annotation overlay"] path') as Element
    fireEvent.pointerDown(path, { pointerType: 'mouse' })

    // Done with an emptied scene → saveOverlay(null) clears overlay_path + sidecar.
    fireEvent.click(screen.getByRole('button', { name: /^done$/i }))
    await waitFor(() => expect(mockApi.youtube.saveOverlay).toHaveBeenCalledOnce())
    expect(mockApi.youtube.saveOverlay.mock.calls[0]?.[0].svg).toBeNull()
  })

  it('Esc with unsaved edits prompts Discard-changes (reopen flow uses escMode=changes)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(SAVED_SVG, { status: 200 }))
    renderReopen(
      <ReopenEditor attachment={ATTACHMENT_WITH_OVERLAY} noteId="v1" onClose={vi.fn()} />,
    )
    await waitFor(() => {
      expect(document.querySelector('svg[aria-label="Annotation overlay"]')).not.toBeNull()
    })
    // Make an edit, then Esc → Discard-changes prompt (NOT discard/keep-orphan).
    drawStroke(document.querySelector('svg[aria-label="Annotation overlay"]') as Element)
    fireEvent.keyDown(window, { key: 'Escape' })
    const prompt = screen.getByTestId('annotate-esc-prompt')
    expect(prompt).toBeInTheDocument()
    // 'changes' mode has no "keep as orphan" button.
    expect(screen.queryByRole('button', { name: /keep as orphan/i })).toBeNull()
  })
})
