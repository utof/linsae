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
import { uninstallHarnessBridge } from './harness-bridge'
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

  it('does not attach the harness bridge when isHarness is false (default)', () => {
    // installMockApi default isHarness:false (tests/setup.tsx)
    renderWithProviders(<CanvasStage {...noopProps} />)
    expect(window.__canvasHarness).toBeUndefined()
  })

  it('attaches the harness bridge when isHarness is true', () => {
    ;(window.api as { isHarness: boolean }).isHarness = true
    renderWithProviders(<CanvasStage {...noopProps} />)
    expect(window.__canvasHarness).toBeDefined()
    // restore so other tests stay on the default surface
    ;(window.api as { isHarness: boolean }).isHarness = false
    uninstallHarnessBridge()
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

  it('(u) §13: the spatial-undo stack survives a feed↔canvas remount via the query cache', async () => {
    // Regression guard for the §13 violation: CanvasStage's undo lived in a bare
    // useRef(emptyUndo()), so the AnimatePresence mode="wait" view toggle (which
    // UNMOUNTS the stage) wiped the stack — ⌘Z after a toggle-back did nothing.
    // useSpatialUndoStore now write-throughs the stack to a query-cache entry
    // (pinned gcTime:Infinity so the observer-less entry isn't GC-evicted — see
    // useSpatialUndoStore's long-feed-park test), so a remount on the SAME client
    // restores it. This test pins the SHORT-park path (immediate toggle-back); the
    // >gcTime survival is the hook's fake-timer test.
    //
    // We can't reliably fire ⌘Z here: react-hotkeys-hook v5's `mod` resolution is
    // platform-flaky under happy-dom (no prior test drives a global useHotkeys
    // hotkey — see DevToolsHud.test.tsx, which switched to a defaultOpen
    // affordance for the same reason). So we assert at the seam the fix introduces:
    // a real create-on-canvas (whose onSuccess calls recordOp through CanvasStage's
    // actual wiring) writes the entry to ['canvas-undo','root'], and that entry is
    // STILL there after the stage unmounts and a fresh instance remounts on the
    // same client. Pre-fix there was no cache write at all → key undefined.
    // The end-to-end "⌘Z applies the survived entry" is covered by the
    // useSpatialUndoStore unit test (ref restore) + applyEntry tests (s/t).
    mockApi.canvas.getState.mockResolvedValue({ camera_x: 0, camera_y: 0, zoom: 1 })
    mockApi.canvas.listLayouts.mockResolvedValue([])
    mockApi.canvas.createNoteAt.mockResolvedValue(note('made', 'made', 'Made on canvas'))
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })

    const first = render(
      <QueryClientProvider client={qc}>
        <CanvasStage {...noopProps} />
      </QueryClientProvider>,
    )
    await waitFor(() => {
      expect(first.container.querySelector('[data-canvas-world]')).not.toBeNull()
    })
    // Create a note on the canvas → records a `place` undo entry (from 'absent').
    fireEvent.dblClick(first.container.querySelector('[data-canvas-world]') as HTMLElement)
    const ta = await screen.findByLabelText('write a note')
    fireEvent.change(ta, { target: { value: 'Made on canvas' } })
    fireEvent.keyDown(ta, { key: 'Enter' })
    await waitFor(() => {
      expect(mockApi.canvas.createNoteAt).toHaveBeenCalled()
    })
    // The entry was written through to the survival cache.
    await waitFor(() => {
      const cached = qc.getQueryData(['canvas-undo', 'root']) as { undo: { past: unknown[] } }
      expect(cached?.undo.past).toHaveLength(1)
    })

    // Toggle to feed → toggle back: unmount the stage, remount a FRESH instance on
    // the same client (exactly what App.tsx's AnimatePresence does). The entry must
    // STILL be present in the cache (the flush on unmount + boot read on remount).
    first.unmount()
    const second = render(
      <QueryClientProvider client={qc}>
        <CanvasStage {...noopProps} />
      </QueryClientProvider>,
    )
    await waitFor(() => {
      expect(second.container.querySelector('[data-canvas-viewport]')).not.toBeNull()
    })
    const survived = qc.getQueryData(['canvas-undo', 'root']) as {
      undo: { past: { op: string; items: { noteId: string }[] }[] }
    }
    expect(survived.undo.past).toHaveLength(1)
    expect(survived.undo.past[0]?.op).toBe('place')
    expect(survived.undo.past[0]?.items[0]?.noteId).toBe('made')
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

  // ---- Task 11: keyboard map + esc cascade -----------------------------------
  //
  // What is HEADLESS-tested here (§15 rows that don't need real pointers/layout):
  //   - ⇧0 → reset zoom to 1 (assert the world transform scale).
  //   - ⇧1 → zoom-to-fit with zero placed cards = no-op (no throw, scale stays).
  //   - arrows → nudge a seeded selection → api.canvas.moveNotes.
  //   - ⌫ → remove a seeded selection → api.canvas.removeNotes.
  //   - esc cascade: the SELECTION-CLEAR step and the PICKER-CLOSE step in
  //     isolation (capture-phase consume on the viewport).
  // What DEFERS to the Plan-4 Playwright harness (needs a real pointer/layout
  // model happy-dom lacks): the esc-cascade ORDERING across the drag/marquee
  // steps (cancelDrag) and one-shot placement, plus the /-picker open-at-cursor
  // anchoring. ⌘J (App-level recentOpen) is NOT asserted here — react-hotkeys-hook
  // `mod` resolution is platform-flaky under happy-dom (see the §13 test above +
  // DevToolsHud.test.tsx); ⌘J's binding lives in App and is covered by the manual
  // smoke (Task 12).
  //
  // Selection is seeded by a real pointerdown on a card at the origin: happy-dom's
  // getBoundingClientRect is all-zero and the camera sits at (0,0), so a click at
  // client (0,0) hit-tests the spatial index at world (0,0) → onCardPointerDown →
  // setSelection([id]). Non-mod keys (digits, arrows, backspace) fire reliably.

  /** Dispatch a physical-key keydown carrying BOTH key + code (the lib reads `code`). */
  function keyDown(node: HTMLElement, init: { key: string; code: string; shiftKey?: boolean }) {
    fireEvent.keyDown(node, { ...init, bubbles: true, cancelable: true })
  }

  it('(v) ⇧0 resets the camera zoom to 1', async () => {
    mockApi.canvas.getState.mockResolvedValue({ camera_x: 0, camera_y: 0, zoom: 1 })
    mockApi.canvas.listLayouts.mockResolvedValue([])
    const { container } = renderWithProviders(<CanvasStage {...noopProps} />)
    await waitFor(() => {
      expect(world(container).style.transform).toBe('translate(0px, 0px) scale(1)')
    })
    const viewport = container.querySelector('[data-canvas-viewport]') as HTMLElement
    // Zoom away from 1 first (ctrl+wheel → scale 2), then ⇧0 must snap back to 1.
    ctrlWheel(viewport, -100)
    await waitFor(() => {
      expect(world(container).style.transform).toContain('scale(2)')
    })
    keyDown(viewport, { key: '0', code: 'Digit0', shiftKey: true })
    await waitFor(() => {
      expect(world(container).style.transform).toContain('scale(1)')
    })
  })

  it('(w) ⇧1 zoom-to-fit with zero placed cards is a no-op (no throw, zoom unchanged)', async () => {
    mockApi.canvas.getState.mockResolvedValue({ camera_x: 0, camera_y: 0, zoom: 1 })
    mockApi.canvas.listLayouts.mockResolvedValue([])
    const { container } = renderWithProviders(<CanvasStage {...noopProps} />)
    await waitFor(() => {
      expect(world(container).style.transform).toBe('translate(0px, 0px) scale(1)')
    })
    const viewport = container.querySelector('[data-canvas-viewport]') as HTMLElement
    keyDown(viewport, { key: '1', code: 'Digit1', shiftKey: true })
    // fitCamera returns the current camera when there are no rects → scale stays 1.
    await waitFor(() => {
      expect(world(container).style.transform).toContain('scale(1)')
    })
  })

  it('(x) arrows nudge a seeded selection → api.canvas.moveNotes', async () => {
    await mountSingleCard('Nudge me')
    const surface = document.querySelector('[data-canvas-world]') as HTMLElement
    // Select the card with a pointerdown at the origin (hit-tests world (0,0)).
    fireEvent.pointerDown(surface, { button: 0, clientX: 0, clientY: 0 })
    const viewport = document.querySelector('[data-canvas-viewport]') as HTMLElement
    keyDown(viewport, { key: 'ArrowRight', code: 'ArrowRight' })
    await waitFor(() => {
      expect(mockApi.canvas.moveNotes).toHaveBeenCalled()
    })
    expect(mockApi.canvas.moveNotes).toHaveBeenCalledWith(
      expect.objectContaining({ canvasId: 'root', arrangementId: 'manual' }),
    )
  })

  it('(y) ⌫ removes a seeded selection from the canvas → api.canvas.removeNotes', async () => {
    await mountSingleCard('Remove me')
    const surface = document.querySelector('[data-canvas-world]') as HTMLElement
    fireEvent.pointerDown(surface, { button: 0, clientX: 0, clientY: 0 })
    const viewport = document.querySelector('[data-canvas-viewport]') as HTMLElement
    keyDown(viewport, { key: 'Backspace', code: 'Backspace' })
    await waitFor(() => {
      expect(mockApi.canvas.removeNotes).toHaveBeenCalled()
    })
    expect(mockApi.canvas.removeNotes).toHaveBeenCalledWith(
      expect.objectContaining({ noteIds: ['e-note'] }),
    )
  })

  it('(y2) "delete note…" invalidates the feed AND ⌘O switcher feeds (note-titles/note-recent)', async () => {
    // Blocker regression (spec §3): the canvas multi-select "delete everywhere"
    // (onDeleteRequest) previously invalidated NOTHING, so after a canvas delete
    // the ⌘O switcher (and the feed) still listed the dead notes. Drive the real
    // delete through the SelectionBar's "delete note…" button with confirm=true,
    // and assert the delete invalidates ['notes'], ['note'], ['note-titles'] AND
    // ['note-recent'] (the four keys the other CanvasStage mutation sites use).
    // A QueryClient we own lets us spy on invalidateQueries directly — no mounted
    // switcher observer is needed (we assert the invalidate CALL, not a refetch),
    // and this genuinely FAILS pre-fix (onDeleteRequest invalidated nothing).
    mockApi.canvas.getState.mockResolvedValue({ camera_x: 0, camera_y: 0, zoom: 1 })
    mockApi.canvas.listLayouts.mockResolvedValue([row('e-note', 0, 0, 1000)])
    mockApi.notes.get.mockResolvedValue(note('e-note', 'e', 'Delete me everywhere'))
    mockApi.notes.delete.mockResolvedValue(note('e-note', 'e', 'Delete me everywhere'))

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries')
    // happy-dom does not implement window.confirm — assign a stub the handler reads.
    const confirmStub = vi.fn(() => true)
    const prevConfirm = window.confirm
    window.confirm = confirmStub as unknown as typeof window.confirm
    try {
      render(
        <QueryClientProvider client={qc}>
          <CanvasStage {...noopProps} />
        </QueryClientProvider>,
      )
      await waitFor(() => expect(screen.queryByText('Delete me everywhere')).toBeTruthy())

      // Select the card (pointerDown at world origin hit-tests e-note), then the
      // SelectionBar's "delete note…" button appears.
      const surface = document.querySelector('[data-canvas-world]') as HTMLElement
      fireEvent.pointerDown(surface, { button: 0, clientX: 0, clientY: 0 })
      fireEvent.pointerUp(surface, { button: 0, clientX: 0, clientY: 0 })
      const deleteBtn = await screen.findByRole('button', { name: /delete note/i })

      fireEvent.click(deleteBtn)

      // The api facade wraps the call as window.api.notes.delete({ id }).
      await waitFor(() => expect(mockApi.notes.delete).toHaveBeenCalledWith({ id: 'e-note' }))
      expect(confirmStub).toHaveBeenCalled()
      // All four feed keys must be invalidated so the delete is reflected everywhere.
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['notes'] })
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['note'] })
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['note-titles'] })
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['note-recent'] })
    } finally {
      window.confirm = prevConfirm
    }
  })

  it('(z) esc cascade — selection-clear step: esc with a selection clears it (no remove)', async () => {
    await mountSingleCard('Select then esc')
    const surface = document.querySelector('[data-canvas-world]') as HTMLElement
    // pointerDown selects the card; pointerUp RELEASES the drag session so esc
    // reaches the selection-clear step (an unreleased pointer is a cancellable
    // drag — #118 — which the cascade would consume FIRST via cancelDrag()).
    fireEvent.pointerDown(surface, { button: 0, clientX: 0, clientY: 0 })
    fireEvent.pointerUp(surface, { button: 0, clientX: 0, clientY: 0 })
    // The selection bar appears once a card is selected (count pill).
    await waitFor(() => {
      expect(screen.queryByText(/1 selected/i)).toBeTruthy()
    })
    // esc on the viewport: the capture-phase cascade clears the selection (the
    // last cascade step before no-op) without removing the card from the canvas.
    const viewport = document.querySelector('[data-canvas-viewport]') as HTMLElement
    keyDown(viewport, { key: 'Escape', code: 'Escape' })
    await waitFor(() => {
      expect(screen.queryByText(/1 selected/i)).toBeNull()
    })
    expect(mockApi.canvas.removeNotes).not.toHaveBeenCalled()
  })

  it('(aa) esc cascade — picker-close step: / opens the picker, esc closes it', async () => {
    mockApi.canvas.getState.mockResolvedValue({ camera_x: 0, camera_y: 0, zoom: 1 })
    mockApi.canvas.listLayouts.mockResolvedValue([])
    const { container } = renderWithProviders(<CanvasStage {...noopProps} />)
    await waitFor(() => {
      expect(container.querySelector('[data-canvas-world]')).not.toBeNull()
    })
    const viewport = container.querySelector('[data-canvas-viewport]') as HTMLElement
    // `/` opens the picker (its input placeholder is the marker).
    keyDown(viewport, { key: '/', code: 'Slash' })
    const input = await screen.findByPlaceholderText('search to place…')
    expect(input).toBeTruthy()
    // esc on the viewport: with no drag/composer active, the cascade closes the
    // picker (the picker-close step). Dispatch on the viewport (not the input) so
    // the capture-phase handler resolves the step, mirroring the §15 cascade.
    keyDown(viewport, { key: 'Escape', code: 'Escape' })
    await waitFor(() => {
      expect(screen.queryByPlaceholderText('search to place…')).toBeNull()
    })
  })

  it('(bb) esc precedence: when the canvas consumes, a document bubble listener (App ladder) does NOT fire', async () => {
    // The crux. App's esc ladder is a BUBBLE-phase document listener
    // (react-hotkeys-hook default). The canvas cascade is a CAPTURE-phase listener
    // on the VIEWPORT node, and it stopPropagation()s when it consumes a step. We
    // stand in for App's ladder with a real document bubble listener and assert it
    // never fires for an esc the canvas consumed (here: closing the picker). This
    // pins precedence by event-phase + tree position — NOT registration order.
    mockApi.canvas.getState.mockResolvedValue({ camera_x: 0, camera_y: 0, zoom: 1 })
    mockApi.canvas.listLayouts.mockResolvedValue([])
    const { container } = renderWithProviders(<CanvasStage {...noopProps} />)
    await waitFor(() => {
      expect(container.querySelector('[data-canvas-world]')).not.toBeNull()
    })
    // Count only ESC keydowns that reach the document (the `/` keydown bubbles
    // there too — that one is irrelevant; the canvas doesn't consume `/`).
    const escAtDocument = vi.fn()
    const appLadder = (e: KeyboardEvent) => {
      if (e.key === 'Escape') escAtDocument()
    }
    document.addEventListener('keydown', appLadder) // bubble phase, document target
    try {
      const viewport = container.querySelector('[data-canvas-viewport]') as HTMLElement
      keyDown(viewport, { key: '/', code: 'Slash' })
      await screen.findByPlaceholderText('search to place…')
      keyDown(viewport, { key: 'Escape', code: 'Escape' })
      await waitFor(() => {
        expect(screen.queryByPlaceholderText('search to place…')).toBeNull()
      })
      // The canvas consumed the esc (picker closed) → the event was stopped on the
      // capture descent and never bubbled to the document listener.
      expect(escAtDocument).not.toHaveBeenCalled()
    } finally {
      document.removeEventListener('keydown', appLadder)
    }
  })

  it('(cc) esc precedence: when the canvas has nothing to consume, the esc bubbles to the document', async () => {
    // The other half: a bare esc on an empty canvas (no composer/drag/picker/
    // placement/selection) is a NO-OP in the cascade — it does NOT stopPropagation,
    // so it bubbles to the document where App's ladder resolves its own steps.
    mockApi.canvas.getState.mockResolvedValue({ camera_x: 0, camera_y: 0, zoom: 1 })
    mockApi.canvas.listLayouts.mockResolvedValue([])
    const { container } = renderWithProviders(<CanvasStage {...noopProps} />)
    await waitFor(() => {
      expect(container.querySelector('[data-canvas-world]')).not.toBeNull()
    })
    const appLadder = vi.fn()
    document.addEventListener('keydown', appLadder)
    try {
      const viewport = container.querySelector('[data-canvas-viewport]') as HTMLElement
      keyDown(viewport, { key: 'Escape', code: 'Escape' })
      // Nothing canvas-owned was open → the cascade no-ops → the esc reaches the
      // document listener (App's ladder gets its turn).
      expect(appLadder).toHaveBeenCalled()
    } finally {
      document.removeEventListener('keydown', appLadder)
    }
  })

  // ---- Bug B1 (double-click empty surface → create) + B3 (click empty →
  // deselect): both share a phantom-occupancy root cause — the hit-test index
  // includes culled / keep-alive cards whose DEFAULT_CARD_HEIGHT rects can cover
  // a VISUALLY-empty point. The create-block (B1) and the click-routing (B3
  // misroute) must reflect actual visible occupancy, not the full cull index.

  it('(dd) B1: double-click over a CULLED (phantom-occupied) point still opens the create composer', async () => {
    // A card placed far off-screen at (5000,5000) is culled (not in visibleIds —
    // the degenerate happy-dom search rect sits at the origin) but its rect still
    // lives in the spatial index at {5000,5000 .. 5360,5140}. A double-click at
    // world (5000,5000) overlaps that phantom rect. PRE-FIX onSurfaceDoubleClick
    // early-returns on ANY index hit → no composer. POST-FIX the create-block
    // only counts VISIBLE cards, so the empty (culled) point creates.
    mockApi.canvas.getState.mockResolvedValue({ camera_x: 0, camera_y: 0, zoom: 1 })
    mockApi.canvas.listLayouts.mockResolvedValue([row('far', 5000, 5000, 1000)])
    mockApi.notes.get.mockResolvedValue(note('far', 'far', 'Far card body'))
    const { container } = renderWithProviders(<CanvasStage {...noopProps} />)
    await waitFor(() => {
      expect(container.querySelector('[data-canvas-world]')).not.toBeNull()
    })
    const surface = container.querySelector('[data-canvas-world]') as HTMLElement
    // Double-click at client (5000,5000) → world (5000,5000): over the phantom rect.
    fireEvent.dblClick(surface, { clientX: 5000, clientY: 5000 })
    // The create composer must open (data-canvas-create wrapper + composer textarea).
    await waitFor(() => {
      expect(container.querySelector('[data-canvas-create]')).not.toBeNull()
    })
    expect(screen.queryByLabelText('write a note')).toBeTruthy()
  })

  it('(ee) B1: double-click directly over a VISIBLE card still edits (does NOT create)', async () => {
    // Guard: the create-block must still suppress create over a genuinely visible
    // card so the card's own dblclick → in-place edit wins (spec §7). Card at the
    // origin is visible (degenerate rect contains (0,0)); a dblclick there must NOT
    // open the create composer.
    await mountSingleCard('Visible card body')
    const surface = document.querySelector('[data-canvas-world]') as HTMLElement
    fireEvent.dblClick(surface, { clientX: 0, clientY: 0 })
    // No create composer (the visible card occupies the point).
    expect(document.querySelector('[data-canvas-create]')).toBeNull()
  })

  it('(ff) B3: a jittery click on truly-empty surface clears the selection', async () => {
    // Select a visible card, then a plain click on truly-empty surface with 1-2px
    // of pointer jitter between down and up. The tiny marquee box this opens hits
    // NO visible card, so the live marquee-replace path sets the selection to the
    // empty hit set → cleared. (Confirmed during root-cause that the bare `moved`
    // flag is not the deselect-failure cause here; the phantom-routing case in
    // (gg) is. This pins the common "jittery empty click deselects" behavior.)
    await mountSingleCard('Jitter target')
    const surface = document.querySelector('[data-canvas-world]') as HTMLElement
    // Select the card (pointerdown at origin hit-tests world (0,0)); release it.
    fireEvent.pointerDown(surface, { button: 0, clientX: 0, clientY: 0 })
    fireEvent.pointerUp(surface, { button: 0, clientX: 0, clientY: 0 })
    await waitFor(() => {
      expect(screen.queryByText(/1 selected/i)).toBeTruthy()
    })
    // A jittery click on EMPTY surface: down → tiny 1px move → up, at a culled
    // point (far from the card so this is the empty surface, not the card).
    fireEvent.pointerDown(surface, { button: 0, clientX: 2000, clientY: 2000 })
    fireEvent.pointerMove(surface, { clientX: 2001, clientY: 2001 })
    fireEvent.pointerUp(surface, { button: 0, clientX: 2001, clientY: 2001 })
    // The selection must clear (the jitter is below the marquee threshold).
    await waitFor(() => {
      expect(screen.queryByText(/1 selected/i)).toBeNull()
    })
  })

  it('(gg) B3: a click on a phantom-occupied (culled) point clears the selection (no reselect)', async () => {
    // Card A visible at the origin (selected); card B culled far away at
    // (5000,5000) — a phantom rect in the index. A plain click at the phantom
    // point routes through onWorldPointerDown. PRE-FIX index.search hits B →
    // onCardPointerDown(B) → reselects the phantom card. POST-FIX only visible
    // cards route to onCardPointerDown, so the click hits empty surface and the
    // selection clears.
    mockApi.canvas.getState.mockResolvedValue({ camera_x: 0, camera_y: 0, zoom: 1 })
    mockApi.canvas.listLayouts.mockResolvedValue([
      row('vis', 0, 0, 1000),
      row('phantom', 5000, 5000, 2000),
    ])
    mockApi.notes.get.mockImplementation(async ({ id }: { id: string }) => {
      if (id === 'vis') return note('vis', 'vis', 'Visible A body')
      if (id === 'phantom') return note('phantom', 'phantom', 'Phantom B body')
      return null
    })
    const { container } = renderWithProviders(<CanvasStage {...noopProps} />)
    await waitFor(() => {
      expect(screen.queryByText('Visible A body')).toBeTruthy()
    })
    const surface = container.querySelector('[data-canvas-world]') as HTMLElement
    // Select the visible card A (down+up at the origin).
    fireEvent.pointerDown(surface, { button: 0, clientX: 0, clientY: 0 })
    fireEvent.pointerUp(surface, { button: 0, clientX: 0, clientY: 0 })
    await waitFor(() => {
      expect(screen.queryByText(/1 selected/i)).toBeTruthy()
    })
    // Click at the phantom point (5000,5000) — visually empty, index-occupied by B.
    fireEvent.pointerDown(surface, { button: 0, clientX: 5000, clientY: 5000 })
    fireEvent.pointerUp(surface, { button: 0, clientX: 5000, clientY: 5000 })
    // The selection must clear — NOT reselect the phantom card B.
    await waitFor(() => {
      expect(screen.queryByText(/1 selected/i)).toBeNull()
    })
  })

  // ---- Bug B4 (§14 G2 centroid pill): the "↖ back to your notes" pill must
  // appear when ≥1 card is placed but ZERO cards intersect the TRUE viewport.
  // Pre-fix it gated on the inflate=1 cull set (visibleIds), so the pill only
  // surfaced after a full extra viewport of pan past the nearest card. The fix
  // gates on trueVisibleIds (visibleWorldRect inflate=0). These tests force a
  // real viewport size via getBoundingClientRect (happy-dom returns zeros, which
  // would collapse BOTH the cull and the true rect to the same degenerate point
  // — indistinguishable). vi.restoreAllMocks in afterEach (above) clears the spy.

  /** A real, non-zero viewport rect so visibleWorldRect doesn't degenerate. */
  function stubViewportRect(w: number, h: number): void {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: w,
      bottom: h,
      width: w,
      height: h,
      toJSON: () => ({}),
    } as DOMRect)
  }

  it('(ii) B4: pill is ABSENT when a card lies in the cull margin but OUTSIDE the true viewport (pre-fix), PRESENT post-fix', async () => {
    // Viewport 800x600 at camera (0,0,1): true viewport = {0..800, 0..600};
    // cull rect (inflate=1) = {-800..1600, -600..1200}. A card at (1000,800)
    // (rect {1000..1360, 800..940}) is INSIDE the cull rect but OUTSIDE the true
    // viewport — exactly the regime spec §14 means by "zero cards intersect the
    // viewport". Pre-fix the pill gated on the cull set → card counted visible →
    // pill hidden. Post-fix it gates on the true-viewport set → pill shown.
    stubViewportRect(800, 600)
    mockApi.canvas.getState.mockResolvedValue({ camera_x: 0, camera_y: 0, zoom: 1 })
    mockApi.canvas.listLayouts.mockResolvedValue([row('off', 1000, 800, 1000)])
    mockApi.notes.get.mockResolvedValue(note('off', 'off', 'Off-screen card body'))
    const { container } = renderWithProviders(<CanvasStage {...noopProps} />)
    await waitFor(() => {
      expect(container.querySelector('[data-canvas-world]')).not.toBeNull()
    })
    // The pill must be present: the only card is outside the true viewport.
    await waitFor(() => {
      expect(container.querySelector('[data-canvas-centroid-arrow]')).not.toBeNull()
    })
  })

  it('(jj) B4: pill is ABSENT when a card DOES intersect the true viewport', async () => {
    // Card at (100,100) — rect {100..460, 100..240} — sits well inside the true
    // viewport {0..800,0..600}, so the pill must NOT appear (the user can see it).
    stubViewportRect(800, 600)
    mockApi.canvas.getState.mockResolvedValue({ camera_x: 0, camera_y: 0, zoom: 1 })
    mockApi.canvas.listLayouts.mockResolvedValue([row('on', 100, 100, 1000)])
    mockApi.notes.get.mockResolvedValue(note('on', 'on', 'On-screen card body'))
    const { container } = renderWithProviders(<CanvasStage {...noopProps} />)
    await waitFor(() => {
      expect(screen.queryByText('On-screen card body')).toBeTruthy()
    })
    expect(container.querySelector('[data-canvas-centroid-arrow]')).toBeNull()
  })

  it('(kk) B4: pill is ABSENT when zero cards are placed (empty canvas → zero state, not the pill)', async () => {
    stubViewportRect(800, 600)
    mockApi.canvas.getState.mockResolvedValue({ camera_x: 0, camera_y: 0, zoom: 1 })
    mockApi.canvas.listLayouts.mockResolvedValue([])
    const { container } = renderWithProviders(<CanvasStage {...noopProps} />)
    await waitFor(() => {
      expect(container.querySelector('[data-canvas-world]')).not.toBeNull()
    })
    expect(container.querySelector('[data-canvas-centroid-arrow]')).toBeNull()
  })

  // ---- Bug #119 (drag-commit snap-back flash): the timing flash itself is not
  // observable in happy-dom (no real rAF/layout), but the fix is an optimistic
  // query-cache write in commitMoves. We assert the cache holds the new x/y
  // SYNCHRONOUSLY after a drag-commit (pointer-up), before any refetch lands —
  // which is what stops the one-frame render at the stale pre-drag position. The
  // definitive flash check is the Plan-4 perf-harness --smoke #119 gate.

  it('(ll) #119: a drag-commit optimistically writes the new x/y into the layout cache', async () => {
    // Card at the origin; select it (pointerdown at (0,0) hit-tests world (0,0)),
    // drag to (120,80), release. happy-dom getBoundingClientRect is all-zero and
    // zoom is 1, so client deltas map 1:1 to world deltas → the card moves to
    // (120,80). After pointer-up the layout cache row must ALREADY carry the new
    // coords (the optimistic write), not the stale (0,0).
    mockApi.canvas.getState.mockResolvedValue({ camera_x: 0, camera_y: 0, zoom: 1 })
    mockApi.canvas.listLayouts.mockResolvedValue([row('drag', 0, 0, 1000)])
    mockApi.notes.get.mockResolvedValue(note('drag', 'drag', 'Drag me'))
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const { container } = render(
      <QueryClientProvider client={qc}>
        <CanvasStage {...noopProps} />
      </QueryClientProvider>,
    )
    await waitFor(() => {
      expect(screen.queryByText('Drag me')).toBeTruthy()
    })
    const surface = container.querySelector('[data-canvas-world]') as HTMLElement
    // pointerdown on the card (selects + starts drag), move, then release.
    // The commit (commitMoves) runs SYNCHRONOUSLY inside the pointerup handler,
    // so we assert the cache immediately after — before refreshCanvas()'s async
    // invalidation can refetch (and, in this mock, clobber back to the stale
    // mock data; real IPC would return the moved coords). The synchronous-write
    // window is exactly what spans the dragOffset-clear frame and kills the flash.
    fireEvent.pointerDown(surface, { button: 0, pointerId: 1, clientX: 0, clientY: 0 })
    fireEvent.pointerMove(surface, { pointerId: 1, clientX: 120, clientY: 80 })
    fireEvent.pointerUp(surface, { button: 0, pointerId: 1, clientX: 120, clientY: 80 })
    // The IPC move fired with the new coords...
    expect(mockApi.canvas.moveNotes).toHaveBeenCalledWith(
      expect.objectContaining({ moves: [{ x: 120, y: 80, noteId: 'drag' }] }),
    )
    // ...AND the optimistic cache write already moved the row to (120,80), so a
    // render after dragOffset clears never paints the stale origin position.
    const cached = qc.getQueryData(['canvas-layouts', 'root']) as Array<{
      note_id: string
      x: number | null
      y: number | null
    }>
    const moved = cached.find((r) => r.note_id === 'drag')
    expect(moved?.x).toBe(120)
    expect(moved?.y).toBe(80)
  })

  it('(hh) B3 no-regression: a real marquee drag over a visible card still selects it', async () => {
    // Guard the threshold fix does not break a genuine rubber-band. A drag well
    // past the movement threshold over the origin card must select it live on
    // pointermove (the additive-union / replace path in onPointerMove).
    await mountSingleCard('Marquee me')
    const surface = document.querySelector('[data-canvas-world]') as HTMLElement
    // Start the marquee on empty surface, then drag a box that encloses the origin
    // card (from (300,300) up-left across (0,0)); the move is far past threshold.
    fireEvent.pointerDown(surface, { button: 0, clientX: 300, clientY: 300 })
    fireEvent.pointerMove(surface, { clientX: -50, clientY: -50 })
    fireEvent.pointerUp(surface, { button: 0, clientX: -50, clientY: -50 })
    // The card inside the band is selected (selection bar shows 1 selected).
    await waitFor(() => {
      expect(screen.queryByText(/1 selected/i)).toBeTruthy()
    })
  })

  it('(mm) #132: a jittery empty-click whose tiny marquee overlaps a card still CLEARS', async () => {
    // The #132 regression: with a selection, a plain EMPTY-surface click that has
    // a few px of pointer jitter between down and up opens a TINY marquee. If that
    // box happens to overlap a card, the live marquee-replace path REPLACES the
    // selection with that card instead of clearing — the multi-selection shrinks
    // rather than deselecting. The slop threshold must classify a sub-threshold
    // move as a CLICK (clear), not a marquee. (Distinct from (ff), whose tiny box
    // hit nothing so it "cleared" by accident.)
    //
    // Setup mirrors (gg): card A visible+selected at the origin; card B is a
    // PHANTOM in the full index near a culled point. The jitter click lands on
    // that culled point → hitVisibleAt is null → routes to the surface (marquee),
    // and the tiny marquee overlaps B in the full index — the exact shrink path.
    mockApi.canvas.getState.mockResolvedValue({ camera_x: 0, camera_y: 0, zoom: 1 })
    mockApi.canvas.listLayouts.mockResolvedValue([
      row('vis', 0, 0, 1000),
      row('phantom', 5000, 5000, 2000),
    ])
    mockApi.notes.get.mockImplementation(async ({ id }: { id: string }) => {
      if (id === 'vis') return note('vis', 'vis', 'Visible A body')
      if (id === 'phantom') return note('phantom', 'phantom', 'Phantom B body')
      return null
    })
    const { container } = renderWithProviders(<CanvasStage {...noopProps} />)
    await waitFor(() => {
      expect(screen.queryByText('Visible A body')).toBeTruthy()
    })
    const surface = container.querySelector('[data-canvas-world]') as HTMLElement
    // Select the visible card A (down+up at the origin).
    fireEvent.pointerDown(surface, { button: 0, clientX: 0, clientY: 0 })
    fireEvent.pointerUp(surface, { button: 0, clientX: 0, clientY: 0 })
    await waitFor(() => {
      expect(screen.queryByText(/1 selected/i)).toBeTruthy()
    })
    // Jittery empty click at the phantom point (5000,5000): down → 1px move → up.
    // The tiny marquee {5000,5000 .. 5001,5001} overlaps phantom B in the full
    // index. Pre-fix the marquee-replace path reselects B (selection shrinks/swaps
    // to B); post-fix the sub-slop move is a click → the selection CLEARS.
    fireEvent.pointerDown(surface, { button: 0, clientX: 5000, clientY: 5000 })
    fireEvent.pointerMove(surface, { clientX: 5001, clientY: 5001 })
    fireEvent.pointerUp(surface, { button: 0, clientX: 5001, clientY: 5001 })
    await waitFor(() => {
      expect(screen.queryByText(/selected/i)).toBeNull()
    })
  })

  // ---- Task 9: drawn-edge selection + deletion -------------------------------
  //
  // The pure hit-test math (nearestDrawnEdge) is unit-tested in
  // edge-geometry.test.ts. Here we drive the COMPONENT wiring headlessly WITHOUT
  // faking canvas hit-testing: two cards placed FAR apart so the drawn edge's
  // clipped segment passes through a VISUALLY-EMPTY world point between them, and
  // a pointerdown there routes to the edge hit-test (hitVisibleAt is null at that
  // point, so onWorldPointerDown reaches hitEdgeAt → setSelectedEdge). The
  // pointer-driven creation + the canvas accent-highlight PIXELS are Task-10
  // smoke-covered (happy-dom has no 2D raster; spec §8 harness tier).
  //
  // Geometry: CARD_WIDTH=360, DEFAULT_CARD_HEIGHT=140. Cards 'a' @ (0,0) and 'b'
  // @ (900,0) → rects {0..360,0..140} & {900..1260,0..140}. The clipped edge
  // segment runs x∈[360,900] at y=70; its midpoint (630,70) sits BETWEEN the
  // cards (not inside either rect) → a visually-empty point → the edge hit.

  /** Seed two far-apart placed cards + one edge between them; wait for ready. */
  async function mountEdgePair(edgeType: string): Promise<HTMLElement> {
    mockApi.canvas.getState.mockResolvedValue({ camera_x: 0, camera_y: 0, zoom: 1 })
    mockApi.canvas.listLayouts.mockResolvedValue([row('a', 0, 0, 1000), row('b', 900, 0, 2000)])
    mockApi.notes.get.mockImplementation(async ({ id }: { id: string }) => {
      if (id === 'a') return note('a', 'a', 'Card A body')
      if (id === 'b') return note('b', 'b', 'Card B body')
      return null
    })
    mockApi.canvas.edges.mockResolvedValue([
      { fromNoteId: 'a', toNoteId: 'b', toSlug: 'b', edgeType },
    ])
    const { container } = renderWithProviders(<CanvasStage {...noopProps} />)
    await waitFor(() => {
      expect(container.querySelector('[data-canvas-world]')).not.toBeNull()
    })
    // Wait until the edge query resolved (so `edges` is non-empty for hitEdgeAt).
    await waitFor(() => {
      expect(mockApi.canvas.edges).toHaveBeenCalled()
    })
    return container.querySelector('[data-canvas-world]') as HTMLElement
  }

  it('(mm) clicking a DRAWN edge then ⌫ deletes that edge (deleteEdge with its PK, NOT removeNotes)', async () => {
    const surface = await mountEdgePair('link')
    // Click the edge midpoint (630,70): visually-empty → routes to the edge
    // hit-test → selectedEdge set. No card is selected (clearSelection ran).
    fireEvent.pointerDown(surface, { button: 0, clientX: 630, clientY: 70 })
    const viewport = document.querySelector('[data-canvas-viewport]') as HTMLElement
    keyDown(viewport, { key: 'Backspace', code: 'Backspace' })
    await waitFor(() => {
      expect(mockApi.canvas.deleteEdge).toHaveBeenCalled()
    })
    // Deleted the exact PK row (the §1 toSlug component), not the note-remove path.
    expect(mockApi.canvas.deleteEdge).toHaveBeenCalledWith(
      expect.objectContaining({
        canvasId: 'root',
        arrangementId: 'manual',
        fromNoteId: 'a',
        toSlug: 'b',
        edgeType: 'link',
      }),
    )
    expect(mockApi.canvas.removeNotes).not.toHaveBeenCalled()
  })

  it('(nn) a reference edge at the same point is NOT selectable → ⌫ deletes nothing (drawn-only)', async () => {
    const surface = await mountEdgePair('reference')
    fireEvent.pointerDown(surface, { button: 0, clientX: 630, clientY: 70 })
    const viewport = document.querySelector('[data-canvas-viewport]') as HTMLElement
    keyDown(viewport, { key: 'Backspace', code: 'Backspace' })
    // No edge was selected (reference is read-only) and no card was selected, so
    // neither delete path fires (decision 6 + the empty-selection ⌫ no-op).
    await waitFor(() => {
      expect(mockApi.canvas.edges).toHaveBeenCalled()
    })
    expect(mockApi.canvas.deleteEdge).not.toHaveBeenCalled()
    expect(mockApi.canvas.removeNotes).not.toHaveBeenCalled()
  })

  it('(oo) esc clears a drawn-edge selection (a subsequent ⌫ deletes nothing)', async () => {
    const surface = await mountEdgePair('link')
    fireEvent.pointerDown(surface, { button: 0, clientX: 630, clientY: 70 })
    const viewport = document.querySelector('[data-canvas-viewport]') as HTMLElement
    // esc on the viewport clears the edge selection (the edge-selection cascade
    // step, before note-selection clear). Then ⌫ must delete nothing.
    keyDown(viewport, { key: 'Escape', code: 'Escape' })
    keyDown(viewport, { key: 'Backspace', code: 'Backspace' })
    await waitFor(() => {
      expect(mockApi.canvas.edges).toHaveBeenCalled()
    })
    expect(mockApi.canvas.deleteEdge).not.toHaveBeenCalled()
  })
})
