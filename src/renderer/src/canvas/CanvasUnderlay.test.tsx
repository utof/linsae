/**
 * Component tests for CanvasUnderlay: rAF scheduling cadence + wiring (#131,
 * first test of this seam). happy-dom's `canvas.getContext('2d')` returns null,
 * so `draw()` is a no-op — these assert SCHEDULING, not pixels.
 *
 * The #112 regression assertion is "Idle when clean" (test 2): after the mount
 * frame flushes, NO new rAF is scheduled. Against the pre-fix perpetual re-arm
 * loop this FAILS (the loop re-arms unconditionally every frame); after the
 * on-demand fix it PASSES.
 *
 * @see src/renderer/src/canvas/CanvasUnderlay.tsx
 * @see docs/specs/v0.4-canvas-mvp.md §3
 * @issue utof/linsae#112
 */
import { render } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CanvasUnderlay } from './CanvasUnderlay'
import type { Camera } from './camera'

// Controllable rAF queue: each requestAnimationFrame captures its callback and
// returns an incrementing non-zero id; flush() invokes + clears the pending
// callbacks (one frame's worth). cancelAnimationFrame records its argument.
let rafCallbacks: Map<number, FrameRequestCallback>
let rafNextId: number
let rafSpy: ReturnType<typeof vi.fn>
let cancelSpy: ReturnType<typeof vi.fn>

function flush(): void {
  const pending = [...rafCallbacks.entries()]
  rafCallbacks.clear()
  for (const [, cb] of pending) cb(performance.now())
}

beforeEach(() => {
  rafCallbacks = new Map()
  rafNextId = 0
  rafSpy = vi.fn((cb: FrameRequestCallback) => {
    rafNextId += 1
    rafCallbacks.set(rafNextId, cb)
    return rafNextId
  })
  cancelSpy = vi.fn((id: number) => {
    rafCallbacks.delete(id)
  })
  vi.stubGlobal('requestAnimationFrame', rafSpy)
  vi.stubGlobal('cancelAnimationFrame', cancelSpy)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const baseCamera: Camera = { x: 0, y: 0, zoom: 1 }

describe('CanvasUnderlay rAF cadence (#112)', () => {
  it('schedules exactly one rAF on mount', () => {
    render(<CanvasUnderlay camera={baseCamera} layers={[]} width={800} height={600} />)
    expect(rafSpy).toHaveBeenCalledTimes(1)
  })

  it('goes idle after the mount frame flushes (no re-arm when clean)', () => {
    render(<CanvasUnderlay camera={baseCamera} layers={[]} width={800} height={600} />)
    expect(rafSpy).toHaveBeenCalledTimes(1)

    // The mount frame: dirty was true → it draws (no-op in happy-dom) + clears
    // dirty. The fix must NOT re-arm here.
    flush()

    // #112 regression assertion: zero rAF scheduled while clean.
    expect(rafSpy).toHaveBeenCalledTimes(1)
  })

  it('wakes on a prop change: a new camera reference schedules one rAF', () => {
    const { rerender } = render(
      <CanvasUnderlay camera={baseCamera} layers={[]} width={800} height={600} />,
    )
    flush()
    expect(rafSpy).toHaveBeenCalledTimes(1)

    // New camera OBJECT (changed reference) → render-time dirty mark → schedule.
    rerender(
      <CanvasUnderlay camera={{ x: 10, y: 0, zoom: 1 }} layers={[]} width={800} height={600} />,
    )
    expect(rafSpy).toHaveBeenCalledTimes(2)
  })

  it('goes idle again after the wake frame flushes', () => {
    const { rerender } = render(
      <CanvasUnderlay camera={baseCamera} layers={[]} width={800} height={600} />,
    )
    flush()
    rerender(
      <CanvasUnderlay camera={{ x: 10, y: 0, zoom: 1 }} layers={[]} width={800} height={600} />,
    )
    expect(rafSpy).toHaveBeenCalledTimes(2)

    flush()
    expect(rafSpy).toHaveBeenCalledTimes(2)
  })

  it('schedules a live mount draw under StrictMode double-invoke', () => {
    // StrictMode simulates unmount→remount on the SAME instance (refs persist).
    // The unmount cleanup cancels the first scheduled frame, so the re-mount
    // must re-arm — i.e. there must be a pending, NOT-cancelled frame after the
    // dust settles, or the underlay would never draw in dev.
    render(
      <StrictMode>
        <CanvasUnderlay camera={baseCamera} layers={[]} width={800} height={600} />
      </StrictMode>,
    )
    // Exactly one rAF id is currently live (scheduled and not cancelled).
    expect(rafCallbacks.size).toBe(1)
  })

  it('cancels the pending frame on unmount', () => {
    const { rerender, unmount } = render(
      <CanvasUnderlay camera={baseCamera} layers={[]} width={800} height={600} />,
    )
    flush()
    // Re-arm a pending frame WITHOUT flushing it.
    rerender(
      <CanvasUnderlay camera={{ x: 10, y: 0, zoom: 1 }} layers={[]} width={800} height={600} />,
    )
    expect(rafSpy).toHaveBeenCalledTimes(2)
    const pendingId = rafSpy.mock.results[1]?.value as number

    unmount()
    expect(cancelSpy).toHaveBeenCalledWith(pendingId)
  })
})
