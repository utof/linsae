/**
 * Component tests for the canvas stage shell: persisted-camera first paint,
 * wheel-zoom transform change, and the persistence flush/write-through cadence
 * (the camera must NOT revert to boot on a same-session toggle-back).
 *
 * @see src/renderer/src/canvas/CanvasStage.tsx
 * @see src/renderer/src/canvas/useCanvasCamera.ts
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { installMockApi, type MockApi, renderWithProviders } from '../../../../tests/setup'
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
  it('renders the viewport and paints the persisted camera transform', async () => {
    mockApi.canvas.getState.mockResolvedValue({ camera_x: 100, camera_y: 50, zoom: 2 })
    const { container } = renderWithProviders(<CanvasStage {...noopProps} />)
    // viewport exists immediately (gestures bind before the boot read resolves)
    expect(container.querySelector('[data-canvas-viewport]')).not.toBeNull()
    // once getState resolves, the world transform = translate(-x*z, -y*z) scale(z)
    await waitFor(() => {
      expect(world(container).style.transform).toBe('translate(-200px, -100px) scale(2)')
    })
  })

  it('ctrl+wheel zoom changes the transform scale', async () => {
    // Boot camera_x = 10 so the persisted transform (translate(-10px,…)) differs
    // from the {0,0,1} initial — an unambiguous "ready" signal to wait on before
    // the wheel (otherwise the initial paint already reads scale(1)/translate 0).
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
    // camera_x = 10 gives a ready signal; the flush is unconditional once ready.
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
