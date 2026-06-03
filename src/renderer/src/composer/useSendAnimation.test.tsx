// @vitest-environment happy-dom
/**
 * Component tests for useSendAnimation — behavior only, NOT trajectory.
 *
 * happy-dom has no layout engine (getBoundingClientRect returns zeros) and no
 * real rAF clock, so these tests assert mount/unmount + the `inFlight` flag + the
 * reduced-motion / null-ref no-ops. Trajectory/visual correctness is verified by
 * the Playwright send-harness, never here. @see docs/specs/v0.2.1-send-animation.md
 */

import { act, render, screen } from '@testing-library/react'
import { type RefObject, useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '../../../../tests/setup'
import { useSendAnimation } from './useSendAnimation'

// A controllable rAF: callbacks queue, and `flushFrames(n)` invokes them with
// advancing timestamps so the tween can be driven to t>=1.
let rafQueue: Array<(ts: number) => void> = []
function flushFrames(count: number, step = 1000): void {
  for (let i = 0; i < count; i++) {
    const cbs = rafQueue
    rafQueue = []
    const ts = (i + 1) * step
    act(() => {
      for (const cb of cbs) cb(ts)
    })
  }
}

beforeEach(() => {
  rafQueue = []
  vi.stubGlobal('requestAnimationFrame', (cb: (ts: number) => void) => {
    rafQueue.push(cb)
    return rafQueue.length
  })
  vi.stubGlobal('cancelAnimationFrame', () => {})
})
afterEach(() => {
  vi.unstubAllGlobals()
})

/**
 * Harness component: wires real refs to two stand-in DOM nodes (the "card" and
 * the "scroller"), exposes `launch` via a button, and renders `inFlight` so tests
 * can assert it directly.
 */
function Harness({ nullRefs = false }: { nullRefs?: boolean }) {
  const cardRef = useRef<HTMLDivElement | null>(null)
  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const { launch, ghost, inFlight } = useSendAnimation({
    cardRef: nullRefs ? ({ current: null } as RefObject<HTMLDivElement | null>) : cardRef,
    scrollerRef: nullRefs ? ({ current: null } as RefObject<HTMLDivElement | null>) : scrollerRef,
  })
  return (
    <div>
      {!nullRefs && (
        <>
          <div data-testid="card" ref={cardRef} />
          <div data-testid="scroller" ref={scrollerRef} />
        </>
      )}
      <div data-testid="in-flight">{inFlight ? 'yes' : 'no'}</div>
      <button type="button" data-testid="launch" onClick={() => launch('hello world', 'claim')}>
        send
      </button>
      {ghost}
    </div>
  )
}

describe('useSendAnimation', () => {
  it('reduced motion → launch renders no send-ghost and stays not-in-flight', () => {
    vi.stubGlobal('matchMedia', () => ({
      matches: true,
      media: '(prefers-reduced-motion: reduce)',
      addEventListener: () => {},
      removeEventListener: () => {},
    }))
    render(<Harness />)
    act(() => {
      screen.getByTestId('launch').click()
    })
    expect(screen.queryByTestId('send-ghost')).not.toBeInTheDocument()
    expect(screen.getByTestId('in-flight')).toHaveTextContent('no')
  })

  it('null card/scroller refs → launch renders no send-ghost', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: false }))
    render(<Harness nullRefs />)
    act(() => {
      screen.getByTestId('launch').click()
    })
    expect(screen.queryByTestId('send-ghost')).not.toBeInTheDocument()
  })

  it('non-reduced → launch mounts a send-ghost + flips inFlight, hands off after the tween', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: false }))
    render(<Harness />)
    act(() => {
      screen.getByTestId('launch').click()
    })
    // Ghost mounts immediately after launch and we are in flight.
    expect(screen.getByTestId('send-ghost')).toBeInTheDocument()
    expect(screen.getByTestId('in-flight')).toHaveTextContent('yes')

    // Drive frames: with a 1000ms step and a 460ms duration the first frame sets
    // the clock origin and the second reaches t>=1 → unmount + hand-off.
    flushFrames(3)
    expect(screen.queryByTestId('send-ghost')).not.toBeInTheDocument()
    expect(screen.getByTestId('in-flight')).toHaveTextContent('no')
  })
})
