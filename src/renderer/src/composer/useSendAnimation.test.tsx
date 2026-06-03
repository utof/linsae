// @vitest-environment happy-dom
/**
 * Component tests for useSendAnimation — behavior only, NOT trajectory.
 *
 * happy-dom has no layout engine (getBoundingClientRect returns zeros) and the
 * flight is a Motion spring, so we mock `motion` to capture the animation's
 * `onComplete` and assert mount → hand-off + the `inFlight` flag + the
 * reduced-motion / null-ref no-ops. Trajectory/visual correctness is verified by
 * the Playwright send-harness, never here. @see docs/specs/v0.2.1-send-animation.md
 */

import { act, render, screen } from '@testing-library/react'
import { type RefObject, useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '../../../../tests/setup'
import { useSendAnimation } from './useSendAnimation'

// Capture the last Motion animation's options so a test can fire its onComplete.
let lastAnimateOpts: { onComplete?: () => void } | null = null
vi.mock('motion', () => ({
  animate: (_el: unknown, _kf: unknown, opts: { onComplete?: () => void }) => {
    lastAnimateOpts = opts
    return { stop: () => {} }
  },
  spring: 'spring',
}))

beforeEach(() => {
  lastAnimateOpts = null
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

  it('non-reduced → launch mounts a send-ghost + flips inFlight, hands off on landing', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: false }))
    render(<Harness />)
    act(() => {
      screen.getByTestId('launch').click()
    })
    // Ghost mounts immediately after launch and we are in flight.
    expect(screen.getByTestId('send-ghost')).toBeInTheDocument()
    expect(screen.getByTestId('in-flight')).toHaveTextContent('yes')

    // The flight is a Motion spring (mocked); landing fires its onComplete, which
    // unmounts the ghost and clears inFlight — the hand-off to the real note.
    act(() => {
      lastAnimateOpts?.onComplete?.()
    })
    expect(screen.queryByTestId('send-ghost')).not.toBeInTheDocument()
    expect(screen.getByTestId('in-flight')).toHaveTextContent('no')
  })
})
