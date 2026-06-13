/**
 * Component tests for the canvas stage shell: persisted-camera first paint,
 * wheel-zoom transform change, the persistence flush/write-through cadence
 * (the camera must NOT revert to boot on a same-session toggle-back), and
 * layout culling + shelved-row handling (Task 6).
 *
 * @see src/renderer/src/canvas/CanvasStage.tsx
 * @see src/renderer/src/canvas/useCanvasCamera.ts
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { installMockApi, type MockApi, renderWithProviders } from '../../../../tests/setup'
import type { Note } from '../../../shared/types'
import { CanvasStage } from './CanvasStage'

let mockApi: MockApi

beforeEach(() => {
  mockApi = installMockApi()
})

const noopProps = { onWikilinkClick: () => {}, resolveSlug: () => false }

/**
 * Dispatch a ctrl+wheel zoom on a node. happy-dom (v20) drops modifier keys
 * from WheelEvent init (WheelEvent doesn't inherit MouseEvent's ctrlKey there),
 * so `fireEvent.wheel(node, { ctrlKey: true })` arrives with ctrlKey undefined.
 * We build the event and defineProperty ctrlKey to exercise the pinch branch.
 */
function ctrlWheel(node: HTMLElement, deltaY: number): void {
  // clientX/Y at the origin so the zoom-about-cursor math keeps camera x/y at 0
  // (happy-dom's getBoundingClientRect returns zeros), isolating the scale change.
  const ev = new WheelEvent('wheel', {
    deltaY,
    clientX: 0,
    clientY: 0,
    bubbles: true,
    cancelable: true,
  })
  Object.defineProperty(ev, 'ctrlKey', { value: true })
  fireEvent(node, ev)
}

/** The single transformed world container (data-canvas-world). */
function world(container: HTMLElement): HTMLElement {
  const el = container.querySelector('[data-canvas-world]')
  if (!el) throw new Error('world container not found')
  return el as HTMLElement
}

describe('CanvasStage', () => {
  it('gates the world on ready and paints it at the persisted camera', async () => {
    // Deferred getState: hold the boot read open so the pre-ready render is
    // observable — the viewport mounts (gestures bind, layout stable) but the
    // world container must be ABSENT until the persisted camera is known.
    let resolveState!: (c: { camera_x: number; camera_y: number; zoom: number }) => void
    mockApi.canvas.getState.mockImplementation(
      () =>
        new Promise((r) => {
          resolveState = r
        }),
    )
    const { container } = renderWithProviders(<CanvasStage {...noopProps} />)
    expect(container.querySelector('[data-canvas-viewport]')).not.toBeNull()
    expect(container.querySelector('[data-canvas-world]')).toBeNull()
    resolveState({ camera_x: 100, camera_y: 50, zoom: 2 })
    // once getState resolves the world appears at translate(-x*z, -y*z) scale(z)
    await waitFor(() => {
      expect(world(container).style.transform).toBe('translate(-200px, -100px) scale(2)')
    })
  })

  it('ctrl+wheel zoom changes the transform scale', async () => {
    // The world only exists once ready, so waiting on its persisted transform
    // (boot camera_x = 10 → translate(-10px,…)) guarantees ready before the wheel.
    mockApi.canvas.getState.mockResolvedValue({ camera_x: 10, camera_y: 0, zoom: 1 })
    const { container } = renderWithProviders(<CanvasStage {...noopProps} />)
    await waitFor(() => {
      expect(world(container).style.transform).toBe('translate(-10px, 0px) scale(1)')
    })
    const viewport = container.querySelector('[data-canvas-viewport]') as HTMLElement
    ctrlWheel(viewport, -100)
    // exp(-(-100)*0.01) = e^1 ≈ 2.718, clamped to ZOOM_MAX = 2.0
    await waitFor(() => {
      expect(world(container).style.transform).toContain('scale(2)')
    })
  })

  it('flushes the camera via api.canvas.setState on unmount', async () => {
    // Waiting on the world's persisted transform guarantees ready; the flush on
    // unmount is unconditional once ready.
    mockApi.canvas.getState.mockResolvedValue({ camera_x: 10, camera_y: 0, zoom: 1 })
    const { container, unmount } = renderWithProviders(<CanvasStage {...noopProps} />)
    await waitFor(() => {
      expect(world(container).style.transform).toBe('translate(-10px, 0px) scale(1)')
    })
    unmount()
    expect(mockApi.canvas.setState).toHaveBeenCalledWith({
      canvasId: 'root',
      camera_x: 10,
      camera_y: 0,
      zoom: 1,
    })
  })

  it('space keydown is prevented on buttons but not in text fields', async () => {
    // Held-space arms pan; without preventDefault a focused button (e.g. the
    // feed|canvas segment) would fire its space-activation on keyup.
    mockApi.canvas.getState.mockResolvedValue({ camera_x: 10, camera_y: 0, zoom: 1 })
    const { container } = renderWithProviders(<CanvasStage {...noopProps} />)
    await waitFor(() => {
      expect(world(container).style.transform).toBe('translate(-10px, 0px) scale(1)')
    })

    const button = document.createElement('button')
    document.body.appendChild(button)
    const onButton = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true })
    button.dispatchEvent(onButton)
    expect(onButton.defaultPrevented).toBe(true)

    const textarea = document.createElement('textarea')
    document.body.appendChild(textarea)
    const inField = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true })
    textarea.dispatchEvent(inField)
    expect(inField.defaultPrevented).toBe(false)

    button.remove()
    textarea.remove()
  })

  it('(d) culling: only the near card body text appears when far card is out of viewport', async () => {
    /**
     * happy-dom's ResizeObserver never fires and getBoundingClientRect returns
     * zeros everywhere, so the viewport size is (0, 0) and visibleWorldRect
     * degenerates to a single point at the camera origin (0, 0). We place the
     * "near" card at world (0, 0) so it intersects the degenerate search rect,
     * and the "far" card at (5000, 5000) so it does not.
     */
    mockApi.canvas.getState.mockResolvedValue({ camera_x: 0, camera_y: 0, zoom: 1 })
    mockApi.canvas.listLayouts.mockResolvedValue([
      {
        canvas_id: 'root',
        arrangement_id: 'manual',
        note_id: 'near-note',
        x: 0,
        y: 0,
        placed_at: 1000,
        created_at: 1000,
        updated_at: 1000,
      },
      {
        canvas_id: 'root',
        arrangement_id: 'manual',
        note_id: 'far-note',
        x: 5000,
        y: 5000,
        placed_at: 2000,
        created_at: 2000,
        updated_at: 2000,
      },
    ])

    const nearNote: Note = {
      id: 'near-note',
      slug: 'near',
      body: 'Near card body text',
      type: 'claim',
      created_at: 1000,
      updated_at: 1000,
      deleted_at: null,
    }
    const farNote: Note = {
      id: 'far-note',
      slug: 'far',
      body: 'Far card body text',
      type: 'claim',
      created_at: 2000,
      updated_at: 2000,
      deleted_at: null,
    }

    // window.api.notes.get receives { id } payload (api facade wraps positional arg)
    mockApi.notes.get.mockImplementation(async ({ id }: { id: string }) => {
      if (id === 'near-note') return nearNote
      if (id === 'far-note') return farNote
      return null
    })

    renderWithProviders(<CanvasStage onWikilinkClick={() => {}} resolveSlug={() => false} />)

    await waitFor(() => {
      expect(screen.queryByText('Near card body text')).toBeTruthy()
    })

    // Far card is outside the degenerate (0,0) search rect and must NOT render
    expect(screen.queryByText('Far card body text')).toBeNull()
  })

  it('(e) a shelved row (x: null) renders no card', async () => {
    mockApi.canvas.getState.mockResolvedValue({ camera_x: 0, camera_y: 0, zoom: 1 })
    mockApi.canvas.listLayouts.mockResolvedValue([
      {
        canvas_id: 'root',
        arrangement_id: 'manual',
        note_id: 'shelved-note',
        x: null,
        y: null,
        placed_at: null,
        created_at: 1000,
        updated_at: 1000,
      },
    ])
    mockApi.notes.get.mockResolvedValue({
      id: 'shelved-note',
      slug: 'shelved',
      body: 'Shelved card body text',
      type: 'claim',
      created_at: 1000,
      updated_at: 1000,
      deleted_at: null,
    } satisfies Note)

    renderWithProviders(<CanvasStage onWikilinkClick={() => {}} resolveSlug={() => false} />)

    // Wait for the world to be ready (getState resolved)
    await waitFor(() => {
      expect(document.querySelector('[data-canvas-world]')).not.toBeNull()
    })

    // The shelved note has no world position → no NoteCard must be rendered
    expect(screen.queryByText('Shelved card body text')).toBeNull()
  })

  it('remount within the same QueryClient reflects the flushed camera, not boot', async () => {
    // getState resolves to the BOOT camera; a wheel-zoom then flush writes through
    // the cache. A second mount (staleTime Infinity → no refetch) must read the
    // flushed value, not the boot value — pins the setQueryData write-through.
    mockApi.canvas.getState.mockResolvedValue({ camera_x: 10, camera_y: 0, zoom: 1 })
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const first = render(
      <QueryClientProvider client={qc}>
        <CanvasStage {...noopProps} />
      </QueryClientProvider>,
    )
    await waitFor(() => {
      expect(world(first.container).style.transform).toBe('translate(-10px, 0px) scale(1)')
    })
    const viewport = first.container.querySelector('[data-canvas-viewport]') as HTMLElement
    ctrlWheel(viewport, -100)
    await waitFor(() => {
      expect(world(first.container).style.transform).toContain('scale(2)')
    })
    first.unmount() // unconditional flush → setQueryData(['canvas-state','root'], {…zoom:2})

    const second = render(
      <QueryClientProvider client={qc}>
        <CanvasStage {...noopProps} />
      </QueryClientProvider>,
    )
    // The second mount reads the cached (flushed) camera → zoom 2, not boot zoom 1.
    await waitFor(() => {
      expect(world(second.container).style.transform).toContain('scale(2)')
    })
  })
})
