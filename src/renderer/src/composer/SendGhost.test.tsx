import { screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { renderWithProviders as render } from '../../../../tests/setup'
import { formatTimeOnly } from '../lib/wallclock'
import { SendGhost } from './SendGhost'

// A fixed instant so the rendered time is deterministic regardless of when the
// suite runs. 2:05 PM / 14:05 in the local TZ.
const AT = new Date(2025, 0, 1, 14, 5).getTime()

describe('SendGhost', () => {
  it('renders a node findable via data-testid="send-ghost"', () => {
    render(<SendGhost body="hello world" mode="claim" top={100} left={50} createdAt={AT} hour12 />)
    expect(screen.getByTestId('send-ghost')).toBeInTheDocument()
  })

  it('renders the body text content', () => {
    render(
      <SendGhost body="test body text" mode="claim" top={100} left={50} createdAt={AT} hour12 />,
    )
    expect(screen.getByText('test body text')).toBeInTheDocument()
  })

  it('renders the wall-clock time so the ghost matches the feed note (12h)', () => {
    render(<SendGhost body="timed" mode="claim" top={0} left={0} createdAt={AT} hour12 />)
    expect(screen.getByText(formatTimeOnly(AT, true))).toBeInTheDocument()
  })

  it('renders the wall-clock time in 24h when hour12 is false', () => {
    render(<SendGhost body="timed" mode="claim" top={0} left={0} createdAt={AT} hour12={false} />)
    expect(screen.getByText(formatTimeOnly(AT, false))).toBeInTheDocument()
  })

  it('is portaled into document.body', () => {
    render(<SendGhost body="portaled" mode="claim" top={100} left={50} createdAt={AT} hour12 />)
    const ghost = screen.getByTestId('send-ghost')
    expect(document.body.contains(ghost)).toBe(true)
  })

  it('root has position:fixed', () => {
    render(<SendGhost body="fixed pos" mode="claim" top={200} left={80} createdAt={AT} hour12 />)
    const ghost = screen.getByTestId('send-ghost')
    expect(ghost).toHaveStyle({ position: 'fixed' })
  })

  it('root has pointer-events:none', () => {
    render(<SendGhost body="no pointer" mode="claim" top={200} left={80} createdAt={AT} hour12 />)
    const ghost = screen.getByTestId('send-ghost')
    expect(ghost).toHaveStyle({ pointerEvents: 'none' })
  })

  it('claim mode applies white background and --border-1 border', () => {
    render(<SendGhost body="claim note" mode="claim" top={100} left={50} createdAt={AT} hour12 />)
    const ghost = screen.getByTestId('send-ghost')
    expect(ghost).toHaveStyle({ background: '#FFFFFF' })
    expect(ghost).toHaveStyle({ border: '1px solid var(--border-1)' })
  })

  it('question mode applies amber background and #FAEAC2 border', () => {
    render(
      <SendGhost
        body="is this a question?"
        mode="question"
        top={100}
        left={50}
        createdAt={AT}
        hour12
      />,
    )
    const ghost = screen.getByTestId('send-ghost')
    expect(ghost).toHaveStyle({ background: '#FFFBF0' })
    expect(ghost).toHaveStyle({ border: '1px solid #FAEAC2' })
  })

  it('forwards an external ref to the root div', () => {
    let capturedRef: HTMLDivElement | null = null
    render(
      <SendGhost
        body="ref test"
        mode="claim"
        top={0}
        left={0}
        createdAt={AT}
        hour12
        ref={(el) => {
          capturedRef = el
        }}
      />,
    )
    const ghost = screen.getByTestId('send-ghost')
    expect(capturedRef).toBe(ghost)
  })
})
