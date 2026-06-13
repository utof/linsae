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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installMockApi, type MockApi, renderWithProviders } from '../../../../tests/setup'
import type { Note } from '../../../shared/types'
import { applyEntry, CanvasStage, type LayoutTimestamps } from './CanvasStage'
import { setCanvasDevLod } from './dev-lod'
import type { UndoEntry } from './undo-stack'

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

  /**
   * A recording 2D context fake. Captures an ordered call log of the draw-path
   * methods plus settable-prop writes so a test can assert ordering and which
   * primitives fired per edge. happy-dom returns null from getContext('2d'), so
   * the real underlay draw path never runs there — this fake makes it run.
   */
  type LogEntry = { op: string; args: unknown[] }
  function makeRecordingCtx(): { ctx: CanvasRenderingContext2D; log: LogEntry[] } {
    const log: LogEntry[] = []
    const rec =
      (op: string) =>
      (...args: unknown[]): void => {
        log.push({ op, args })
      }
    const ctx = {
      setTransform: rec('setTransform'),
      clearRect: rec('clearRect'),
      beginPath: rec('beginPath'),
      moveTo: rec('moveTo'),
      lineTo: rec('lineTo'),
      stroke: rec('stroke'),
      save: rec('save'),
      restore: rec('restore'),
      setLineDash: rec('setLineDash'),
      set globalAlpha(v: number) {
        log.push({ op: 'set:globalAlpha', args: [v] })
      },
      set lineWidth(v: number) {
        log.push({ op: 'set:lineWidth', args: [v] })
      },
      set strokeStyle(v: string) {
        log.push({ op: 'set:strokeStyle', args: [v] })
      },
    } as unknown as CanvasRenderingContext2D
    return { ctx, log }
  }

  /**
   * Drives the underlay's rAF loop synchronously. requestAnimationFrame is
   * stubbed to enqueue callbacks; flush() runs the queue a bounded number of
   * times so the dirty frame executes and the test TERMINATES (the loop
   * reschedules itself, so an unbounded synchronous flush would spin forever).
   */
  function installRafHarness() {
    const queue: FrameRequestCallback[] = []
    const rafSpy = vi
      .spyOn(globalThis, 'requestAnimationFrame')
      .mockImplementation((cb: FrameRequestCallback) => {
        queue.push(cb)
        return queue.length
      })
    const cancelSpy = vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {})
    const flush = (frames: number): void => {
      for (let i = 0; i < frames; i++) {
        const cb = queue.shift()
        if (!cb) return
        cb(performance.now())
      }
    }
    return { flush, rafSpy, cancelSpy }
  }

  afterEach(() => {
    vi.restoreAllMocks()
    // setCanvasDevLod is module-global; reset to defaults so a forceTier/dots
    // toggle in one test never leaks into the next.
    setCanvasDevLod({ forceTier: 'auto', unclampZoom: false, syntheticDots: false })
  })

  it('(i) regression: clearRect runs under identity, not the camera matrix (no ghosting on pan)', async () => {
    // happy-dom returns null from getContext('2d'), so the draw path is invisible
    // there. We stub a recording 2D context + a synchronous rAF harness so the
    // underlay loop actually executes, then assert the per-frame transform order.
    //
    // PRE-FIX (clearRect before setTransform-to-camera): the clearRect call is
    // immediately preceded by the camera setTransform (or, on frame 1, nothing) —
    // it clears under the camera matrix. This test asserts clearRect is preceded
    // by an IDENTITY setTransform(1,0,0,1,0,0), which FAILS on the pre-fix order.
    const { ctx, log } = makeRecordingCtx()
    const getCtxSpy = vi
      .spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockReturnValue(ctx as unknown as RenderingContext)
    const { flush } = installRafHarness()

    mockApi.canvas.getState.mockResolvedValue({ camera_x: 0, camera_y: 0, zoom: 1 })
    mockApi.canvas.listLayouts.mockResolvedValue([row('a', 0, 0, 1000), row('b', 500, 0, 2000)])
    mockApi.canvas.edges.mockResolvedValue([
      { fromNoteId: 'a', toNoteId: 'b', edgeType: 'reference' },
    ])

    const { container } = renderWithProviders(<CanvasStage {...noopProps} />)
    // Gate on the underlay canvas being mounted (requires ready AND the loop
    // effect to have scheduled a frame via our stub). Then run the dirty frame.
    await waitFor(() => {
      expect(container.querySelector('canvas')).not.toBeNull()
      flush(3)
      expect(getCtxSpy).toHaveBeenCalledWith('2d')
    })

    const clearIdx = log.findIndex((e) => e.op === 'clearRect')
    expect(clearIdx).toBeGreaterThanOrEqual(0)
    // The op immediately BEFORE clearRect must be an identity setTransform.
    const before = log[clearIdx - 1]
    expect(before?.op).toBe('setTransform')
    expect(before?.args).toEqual([1, 0, 0, 1, 0, 0]) // identity — the regression guard
    container.remove()
  })

  it('(j) regression: dangling/null-segment edges produce no moveTo/lineTo in the draw loop', async () => {
    // The skip branches (unplaced endpoint, edgeSegment null) are structurally
    // present but never EXECUTE under happy-dom. With the draw path running, a
    // valid edge must stroke (one moveTo/lineTo) while a dangling edge must not.
    const { ctx, log } = makeRecordingCtx()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
      ctx as unknown as RenderingContext,
    )
    const { flush } = installRafHarness()

    mockApi.canvas.getState.mockResolvedValue({ camera_x: 0, camera_y: 0, zoom: 1 })
    mockApi.canvas.listLayouts.mockResolvedValue([row('a', 0, 0, 1000), row('b', 500, 0, 2000)])
    mockApi.canvas.edges.mockResolvedValue([
      { fromNoteId: 'a', toNoteId: 'b', edgeType: 'reference' }, // valid → strokes
      { fromNoteId: 'a', toNoteId: 'ghost', edgeType: 'reference' }, // dangling → skipped
      { fromNoteId: 'a', toNoteId: 'a', edgeType: 'reference' }, // self → edgeSegment null
    ])

    const { container } = renderWithProviders(<CanvasStage {...noopProps} />)
    await waitFor(() => {
      expect(container.querySelector('canvas')).not.toBeNull()
      flush(3)
      expect(log.some((e) => e.op === 'clearRect')).toBe(true) // draw pass ran
    })

    // Exactly ONE edge drew: the valid a→b. Dangling + self-edge contributed none.
    expect(log.filter((e) => e.op === 'moveTo')).toHaveLength(1)
    expect(log.filter((e) => e.op === 'lineTo')).toHaveLength(1)
    expect(log.filter((e) => e.op === 'stroke')).toHaveLength(1)
    container.remove()
  })

  it('(k) regression: reference strokes solid, comment-on sets a non-empty dash', async () => {
    const { ctx, log } = makeRecordingCtx()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
      ctx as unknown as RenderingContext,
    )
    const { flush } = installRafHarness()

    mockApi.canvas.getState.mockResolvedValue({ camera_x: 0, camera_y: 0, zoom: 1 })
    mockApi.canvas.listLayouts.mockResolvedValue([
      row('a', 0, 0, 1000),
      row('b', 500, 0, 2000),
      row('c', 0, 500, 3000),
    ])
    mockApi.canvas.edges.mockResolvedValue([
      { fromNoteId: 'a', toNoteId: 'b', edgeType: 'reference' },
      { fromNoteId: 'a', toNoteId: 'c', edgeType: 'comment-on' },
    ])

    const { container } = renderWithProviders(<CanvasStage {...noopProps} />)
    await waitFor(() => {
      expect(container.querySelector('canvas')).not.toBeNull()
      flush(3)
      expect(log.some((e) => e.op === 'stroke')).toBe(true) // both edges drew
    })

    // setLineDash([]) for solid (reference), and setLineDash([..,..]) for dashed.
    const dashCalls = log.filter((e) => e.op === 'setLineDash').map((e) => e.args[0] as number[])
    expect(dashCalls.some((d) => Array.isArray(d) && d.length === 0)).toBe(true) // solid branch
    expect(dashCalls.some((d) => Array.isArray(d) && d.length > 0)).toBe(true) // dashed branch
    container.remove()
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

  // ---- Task 8: in-place card edit + dot tier ---------------------------------

  /** Mount a single placed card at the origin (visible in the degenerate rect). */
  async function mountSingleCard(body: string): Promise<void> {
    mockApi.canvas.getState.mockResolvedValue({ camera_x: 0, camera_y: 0, zoom: 1 })
    mockApi.canvas.listLayouts.mockResolvedValue([row('e-note', 0, 0, 1000)])
    mockApi.notes.get.mockResolvedValue(note('e-note', 'e', body))
    renderWithProviders(<CanvasStage {...noopProps} />)
    await waitFor(() => {
      expect(screen.queryByText(body)).toBeTruthy()
    })
  }

  it('(l) double-click a card opens an edit Composer prefilled with the note body', async () => {
    await mountSingleCard('Editable card body')
    fireEvent.doubleClick(screen.getByText('Editable card body'))
    // The edit-mode Composer textarea appears, prefilled with the body.
    await waitFor(() => {
      const ta = screen.getByLabelText('write a note') as HTMLTextAreaElement
      expect(ta.value).toBe('Editable card body')
    })
  })

  it('(m) submitting the editor (Enter) calls api.notes.update with id + new body', async () => {
    mockApi.notes.update.mockResolvedValue(note('e-note', 'e', 'New body'))
    await mountSingleCard('Old body')
    fireEvent.doubleClick(screen.getByText('Old body'))
    const ta = await screen.findByLabelText('write a note')
    // Change the text, then press Enter (Composer submits on ↵ without shift).
    fireEvent.change(ta, { target: { value: 'New body' } })
    fireEvent.keyDown(ta, { key: 'Enter' })
    await waitFor(() => {
      expect(mockApi.notes.update).toHaveBeenCalled()
    })
    // api facade: api.notes.update(id, body, type) → window.api.notes.update({...}).
    expect(mockApi.notes.update).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'e-note', body: 'New body', type: 'claim' }),
    )
  })

  it('(n) Escape closes the editor without calling api.notes.update', async () => {
    await mountSingleCard('Esc body')
    fireEvent.doubleClick(screen.getByText('Esc body'))
    const ta = await screen.findByLabelText('write a note')
    fireEvent.keyDown(ta, { key: 'Escape' })
    // Editor gone; no write attempted.
    await waitFor(() => {
      expect(screen.queryByLabelText('write a note')).toBeNull()
    })
    expect(mockApi.notes.update).not.toHaveBeenCalled()
  })

  it('(o) force-tier dot renders no card bodies (cards unmount, dots stand in)', async () => {
    mockApi.canvas.getState.mockResolvedValue({ camera_x: 0, camera_y: 0, zoom: 1 })
    mockApi.canvas.listLayouts.mockResolvedValue([row('d-note', 0, 0, 1000)])
    mockApi.notes.get.mockResolvedValue(note('d-note', 'd', 'Dot tier body'))
    renderWithProviders(<CanvasStage {...noopProps} />)
    // Card renders at the card tier first.
    await waitFor(() => {
      expect(screen.queryByText('Dot tier body')).toBeTruthy()
    })
    // Force the dot tier: the card body must disappear (no NoteCards rendered).
    setCanvasDevLod({ forceTier: 'dot' })
    await waitFor(() => {
      expect(screen.queryByText('Dot tier body')).toBeNull()
    })
  })

  it('(p) a save error surfaces inline, keeps the editor open, then a retry clears it', async () => {
    // Fix guard: before the fix `commitEdit` had no onError and the Composer got
    // no error/onClearError, so a rejected api.notes.update was SWALLOWED — the
    // error text never appeared and (since onSuccess never ran) the editor stayed
    // open but with no feedback. This test pins feed parity (App.tsx inline error).
    const DUP = 'A note titled "Dup" already exists'
    // First attempt rejects (duplicate-slug from save-note.ts), second resolves.
    mockApi.notes.update
      .mockRejectedValueOnce(new Error(DUP))
      .mockResolvedValueOnce(note('e-note', 'e', 'Renamed body'))
    await mountSingleCard('Original body')
    fireEvent.doubleClick(screen.getByText('Original body'))
    const ta = (await screen.findByLabelText('write a note')) as HTMLTextAreaElement

    // Submit a body that collides → the mutation rejects.
    fireEvent.keyDown(ta, { key: 'Enter' })

    // (a) the error message appears in the Composer's error UI.
    await waitFor(() => {
      expect(screen.getByText(DUP)).toBeTruthy()
    })
    // (b) editor stays open with the user's text preserved (not unmounted/reset).
    expect(screen.getByLabelText('write a note')).toBe(ta)
    expect(ta.value).toBe('Original body')

    // Edit the body (clears the error via onClearError) and resubmit → resolves.
    fireEvent.change(ta, { target: { value: 'Renamed body' } })
    fireEvent.keyDown(ta, { key: 'Enter' })

    // (c) the successful update clears the error AND closes the editor.
    await waitFor(() => {
      expect(screen.queryByLabelText('write a note')).toBeNull()
    })
    expect(screen.queryByText(DUP)).toBeNull()
    expect(mockApi.notes.update).toHaveBeenCalledTimes(2)
  })

  // ---- Task 8: interactions, create-on-canvas, one-shot ghost, undo ----------

  it('(q) double-click the empty world → create Composer; submit → createNoteAt', async () => {
    mockApi.canvas.getState.mockResolvedValue({ camera_x: 0, camera_y: 0, zoom: 1 })
    mockApi.canvas.listLayouts.mockResolvedValue([])
    const { container } = renderWithProviders(<CanvasStage {...noopProps} />)
    await waitFor(() => {
      expect(container.querySelector('[data-canvas-world]')).not.toBeNull()
    })
    const surface = container.querySelector('[data-canvas-world]') as HTMLElement
    fireEvent.dblClick(surface)
    // A create-mode Composer textarea appears (no card was double-clicked).
    const ta = await screen.findByLabelText('write a note')
    fireEvent.change(ta, { target: { value: 'New canvas note' } })
    fireEvent.keyDown(ta, { key: 'Enter' })
    await waitFor(() => {
      expect(mockApi.canvas.createNoteAt).toHaveBeenCalled()
    })
    // happy-dom getBoundingClientRect is all-zero, so the double-click world point
    // is the camera origin (0,0); assert the body + that x/y are finite numbers
    // (not the exact coords, which the harness can't supply).
    expect(mockApi.canvas.createNoteAt).toHaveBeenCalledWith(
      expect.objectContaining({
        canvasId: 'root',
        arrangementId: 'manual',
        body: 'New canvas note',
        x: expect.any(Number),
        y: expect.any(Number),
      }),
    )
  })

  it('(r) placing prop renders the one-shot banner; a click commits via placeNote', async () => {
    mockApi.canvas.getState.mockResolvedValue({ camera_x: 0, camera_y: 0, zoom: 1 })
    mockApi.canvas.listLayouts.mockResolvedValue([])
    const onPlacingDone = vi.fn()
    const { container } = renderWithProviders(
      <CanvasStage
        {...noopProps}
        placing={{ noteId: 'n1', title: 'my note' }}
        onPlacingDone={onPlacingDone}
      />,
    )
    // (b) the banner text renders.
    await waitFor(() => {
      expect(screen.getByText(/placing "my note"/)).toBeTruthy()
    })
    // A click on the viewport commits the one-shot placement (placeNote + done).
    const viewport = container.querySelector('[data-canvas-viewport]') as HTMLElement
    fireEvent.click(viewport)
    await waitFor(() => {
      expect(mockApi.canvas.placeNote).toHaveBeenCalled()
    })
    expect(mockApi.canvas.placeNote).toHaveBeenCalledWith(
      expect.objectContaining({ canvasId: 'root', arrangementId: 'manual', noteId: 'n1' }),
    )
    expect(onPlacingDone).toHaveBeenCalled()
  })

  it('(s) applyEntry: remove→undo restores via restoreLayouts with preserved timestamps', async () => {
    // The crux headless assertion (Step 6d). `applyEntry` is EXPORTED so this
    // round-trip needs no pointer-driven selection: build a `remove` entry (a card
    // at (40,60) → 'absent'), stash its timestamps, and undo it. Undoing a remove
    // must call restoreLayouts (NOT placeNote) with the prior position AND the
    // ORIGINAL createdAt/placedAt — re-stamping would corrupt the §2 recency rule.
    const canvas = {
      placeNote: vi.fn(async () => undefined),
      moveNotes: vi.fn(async () => undefined),
      unplaceNotes: vi.fn(async () => undefined),
      restoreLayouts: vi.fn(async () => undefined),
      removeNotes: vi.fn(async () => undefined),
    }
    const timestamps: LayoutTimestamps = new Map([['n1', { createdAt: 111, placedAt: 222 }]])
    const entry: UndoEntry = {
      op: 'remove',
      items: [{ noteId: 'n1', from: { x: 40, y: 60 }, to: 'absent' }],
    }
    // Forward (redo): reaching 'absent' removes the row.
    await applyEntry(entry, 'redo', { canvas, timestamps })
    expect(canvas.removeNotes).toHaveBeenCalledWith(expect.objectContaining({ noteIds: ['n1'] }))
    // Backward (undo): restore the row with the prior pos + preserved timestamps.
    await applyEntry(entry, 'undo', { canvas, timestamps })
    expect(canvas.placeNote).not.toHaveBeenCalled()
    expect(canvas.restoreLayouts).toHaveBeenCalledWith(
      expect.objectContaining({
        canvasId: 'root',
        arrangementId: 'manual',
        rows: [{ noteId: 'n1', x: 40, y: 60, createdAt: 111, placedAt: 222 }],
      }),
    )
  })

  it('(t) applyEntry: place-from-shelf undo reshelves via unplaceNotes', async () => {
    // A `place` op whose `from` is 'shelf' (the picker placed a shelved note):
    // undo must reshelf it (unplaceNotes), redo must re-place it (placeNote).
    const canvas = {
      placeNote: vi.fn(async () => undefined),
      moveNotes: vi.fn(async () => undefined),
      unplaceNotes: vi.fn(async () => undefined),
      restoreLayouts: vi.fn(async () => undefined),
      removeNotes: vi.fn(async () => undefined),
    }
    const entry: UndoEntry = {
      op: 'place',
      items: [{ noteId: 'n2', from: 'shelf', to: { x: 10, y: 20 } }],
    }
    await applyEntry(entry, 'undo', { canvas, timestamps: new Map() })
    expect(canvas.unplaceNotes).toHaveBeenCalledWith(expect.objectContaining({ noteIds: ['n2'] }))
    await applyEntry(entry, 'redo', { canvas, timestamps: new Map() })
    expect(canvas.placeNote).toHaveBeenCalledWith(
      expect.objectContaining({ noteId: 'n2', x: 10, y: 20 }),
    )
  })
})
