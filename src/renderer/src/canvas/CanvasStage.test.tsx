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
import { StrictMode } from 'react'
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

  /**
   * Build a placed layout row. happy-dom never fires ResizeObserver and
   * getBoundingClientRect returns zeros, so the cull search rect degenerates to
   * the single point at the camera origin (0,0). A card whose rect contains
   * (0,0) is visible; one placed far away is culled. We flip visibility by
   * rewriting the layout query data (not by moving the camera), keeping the
   * notes placed throughout.
   */
  function row(noteId: string, x: number, y: number, placedAt: number) {
    return {
      canvas_id: 'root',
      arrangement_id: 'manual',
      note_id: noteId,
      x,
      y,
      placed_at: placedAt,
      created_at: placedAt,
      updated_at: placedAt,
    }
  }

  function note(id: string, slug: string, body: string): Note {
    return {
      id,
      slug,
      body,
      type: 'claim',
      created_at: 1000,
      updated_at: 1000,
      deleted_at: null,
    }
  }

  it('keep-alive: a card that exits the viewport stays mounted (display:none), same DOM node', async () => {
    // Camera at origin; card A starts at (0,0) → visible, card B far → culled.
    // Rewriting the layout data so A moves far and B moves to the origin makes A
    // EXIT the visible set. Keep-alive must keep A's SAME DOM element mounted and
    // hidden on the very render it exits (not unmount-then-remount).
    //
    // Fails on pre-fix 6f91255: exit-tracking lived in a post-render bare effect,
    // so on the render A exits, keepAliveIds was still computed from the EMPTY
    // queue → A was filtered out of cardsToRender and removed from the DOM (no
    // re-render brings it back). The post-fix in-render exit tracking keeps it.
    mockApi.canvas.getState.mockResolvedValue({ camera_x: 0, camera_y: 0, zoom: 1 })
    mockApi.canvas.listLayouts.mockResolvedValue([
      row('a-note', 0, 0, 1000),
      row('b-note', 5000, 5000, 2000),
    ])
    mockApi.notes.get.mockImplementation(async ({ id }: { id: string }) => {
      if (id === 'a-note') return note('a-note', 'a', 'Alpha card body')
      if (id === 'b-note') return note('b-note', 'b', 'Bravo card body')
      return null
    })
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={qc}>
        <CanvasStage {...noopProps} />
      </QueryClientProvider>,
    )

    // A visible initially; grab its card shell (walk up from the body text).
    let alphaText!: HTMLElement
    await waitFor(() => {
      alphaText = screen.getByText('Alpha card body')
    })
    const alphaShell = alphaText.closest('[style]')?.parentElement as HTMLElement
    expect(alphaShell).toBeTruthy()

    // Flip: A → far (exits), B → origin (enters). Note stays placed (just moved).
    qc.setQueryData(
      ['canvas-layouts', 'root'],
      [row('a-note', 5000, 5000, 1000), row('b-note', 0, 0, 2000)],
    )

    // B enters and renders.
    await waitFor(() => {
      expect(screen.queryByText('Bravo card body')).toBeTruthy()
    })

    // A's text is STILL in the document (kept alive), and its card shell is the
    // SAME element object as before, now display:none.
    const alphaAfter = screen.queryByText('Alpha card body')
    expect(alphaAfter).toBeTruthy()
    const alphaShellAfter = alphaAfter?.closest('[style]')?.parentElement as HTMLElement
    expect(alphaShellAfter).toBe(alphaShell) // same DOM node — not unmount/remount
    expect(alphaShellAfter.style.display).toBe('none')

    // Re-enter A → visible again, never removed.
    qc.setQueryData(
      ['canvas-layouts', 'root'],
      [row('a-note', 0, 0, 1000), row('b-note', 5000, 5000, 2000)],
    )
    await waitFor(() => {
      const a = screen.getByText('Alpha card body')
      const shell = a.closest('[style]')?.parentElement as HTMLElement
      expect(shell.style.display).not.toBe('none')
    })
  })

  it('keep-alive under StrictMode: single dup-free DOM node across many exits/re-entries', async () => {
    // Wraps the stage in <StrictMode> (prod wraps the app in StrictMode too —
    // main.tsx) so the render + keep-alive useMemo body double-invoke. The
    // keep-alive memo mutates refs during render; if it were not idempotent under
    // double-invocation, the queue would desync (duplicate or drop the card),
    // surfacing as zero or >1 DOM nodes for the note. We assert exactly one node
    // at every settle point across repeated exit/re-enter cycles.
    //
    // Note (honest): this passes trivially on pre-fix 6f91255 because there the
    // cull index never recomputes on a layout-data change, so the visibility flip
    // doesn't even take effect. Its value is post-fix: a permanent guard that the
    // in-render exit-tracking stays double-invocation-safe.
    mockApi.canvas.getState.mockResolvedValue({ camera_x: 0, camera_y: 0, zoom: 1 })
    const placedFar = [row('k-note', 5000, 5000, 1000)]
    const placedOrigin = [row('k-note', 0, 0, 1000)]
    mockApi.canvas.listLayouts.mockResolvedValue(placedOrigin)
    mockApi.notes.get.mockImplementation(async ({ id }: { id: string }) => {
      if (id === 'k-note') return note('k-note', 'k', 'Kilo card body')
      return null
    })
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <StrictMode>
        <QueryClientProvider client={qc}>
          <CanvasStage {...noopProps} />
        </QueryClientProvider>
      </StrictMode>,
    )
    await waitFor(() => {
      expect(screen.queryByText('Kilo card body')).toBeTruthy()
    })

    for (let i = 0; i < 5; i++) {
      qc.setQueryData(['canvas-layouts', 'root'], placedFar)
      await waitFor(() => {
        expect(screen.getAllByText('Kilo card body').length).toBe(1) // kept alive, single node
      })
      qc.setQueryData(['canvas-layouts', 'root'], placedOrigin)
      await waitFor(() => {
        expect(screen.getAllByText('Kilo card body').length).toBe(1) // visible, single node
      })
    }
  })

  // ---- Task 7: CanvasUnderlay wiring tests ----------------------------------

  it('(f) underlay canvas element exists when ready', async () => {
    // happy-dom has no real 2D raster; we assert wiring (element present in the
    // DOM), not pixels. The underlay must mount under the ready gate alongside
    // the world container, positioned BEFORE it so cards sit on top.
    mockApi.canvas.getState.mockResolvedValue({ camera_x: 0, camera_y: 0, zoom: 1 })
    mockApi.canvas.listLayouts.mockResolvedValue([])
    mockApi.canvas.edges.mockResolvedValue([])

    const { container } = renderWithProviders(<CanvasStage {...noopProps} />)

    await waitFor(() => {
      // World container must be present (ready gate lifted).
      expect(container.querySelector('[data-canvas-world]')).not.toBeNull()
    })

    // The underlay <canvas> must also be present.
    const underlayCanvas = container.querySelector('canvas')
    expect(underlayCanvas).not.toBeNull()
  })

  it('(g) api.canvas.edges is called with ROOT_CANVAS_ID and MANUAL_ARRANGEMENT_ID', async () => {
    mockApi.canvas.getState.mockResolvedValue({ camera_x: 0, camera_y: 0, zoom: 1 })
    mockApi.canvas.listLayouts.mockResolvedValue([])
    mockApi.canvas.edges.mockResolvedValue([])

    renderWithProviders(<CanvasStage {...noopProps} />)

    await waitFor(() => {
      // Edges query must have been issued with BOTH key constants.
      expect(mockApi.canvas.edges).toHaveBeenCalledWith({
        canvasId: 'root',
        arrangementId: 'manual',
      })
    })
  })

  it('(h) dangling edge (unplaced endpoint) does not crash; null-context mount is clean', async () => {
    // Two placed rows + one edge whose "to" note is not placed (dangling).
    // The component must mount and unmount without throwing.
    mockApi.canvas.getState.mockResolvedValue({ camera_x: 0, camera_y: 0, zoom: 1 })
    mockApi.canvas.listLayouts.mockResolvedValue([
      row('note-a', 0, 0, 1000),
      row('note-b', 500, 0, 2000),
    ])
    mockApi.canvas.edges.mockResolvedValue([
      // Valid edge between the two placed notes.
      { fromNoteId: 'note-a', toNoteId: 'note-b', edgeType: 'reference' },
      // Dangling: 'ghost-note' has no placed layout row.
      { fromNoteId: 'note-a', toNoteId: 'ghost-note', edgeType: 'comment-on' },
    ])

    // No throw on mount or unmount (dangling edge is silently skipped).
    const { unmount } = renderWithProviders(<CanvasStage {...noopProps} />)

    await waitFor(() => {
      expect(mockApi.canvas.edges).toHaveBeenCalled()
    })

    // Verify the underlay element exists (getContext('2d') returns null in
    // happy-dom — the no-op path must not throw).
    // unmount to exercise RAF cleanup.
    expect(() => unmount()).not.toThrow()
  })

  it('index built from real x/y: a card at the origin renders on first paint (no measure-time teleport)', async () => {
    // Regression guard for Bug 1 (measure-time origin teleport). The bug needed a
    // real ResizeObserver firing handleMeasured with setCard(0,0); happy-dom never
    // fires RO, so this cannot reproduce the teleport directly. It pins the final
    // design's structural invariant instead: the cull index is built from each
    // row's real x/y, so a card placed AT the origin is visible on first paint
    // (its rect contains the degenerate (0,0) search point). This passes on both
    // pre- and post-fix code (documented: not a pre-fix-failing test) — it locks
    // the invariant the restructure makes true by construction.
    mockApi.canvas.getState.mockResolvedValue({ camera_x: 0, camera_y: 0, zoom: 1 })
    mockApi.canvas.listLayouts.mockResolvedValue([row('here', 0, 0, 1000)])
    mockApi.notes.get.mockResolvedValue(note('here', 'here', 'Here card body'))
    renderWithProviders(<CanvasStage {...noopProps} />)
    await waitFor(() => {
      expect(screen.queryByText('Here card body')).toBeTruthy()
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
