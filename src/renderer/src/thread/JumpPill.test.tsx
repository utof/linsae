// @vitest-environment happy-dom
/**
 * Component tests for JumpPill.
 *
 * Assertions:
 *   (a) renders the "jump to now" label + the formatted clock time
 *   (b) renders an icon (the ArrowDown svg)
 *   (c) clicking the pill calls onJump
 *
 * @see src/renderer/src/thread/JumpPill.tsx
 */

import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { JumpPill } from './JumpPill'

describe('JumpPill', () => {
  it('(a) renders the label and the formatted clock time', () => {
    render(<JumpPill seconds={83} onJump={vi.fn()} />)
    expect(screen.getByText(/jump to now/i)).toBeInTheDocument()
    // 83 s → 1:23
    expect(screen.getByText('1:23')).toBeInTheDocument()
  })

  it('(b) renders an icon (svg)', () => {
    const { container } = render(<JumpPill seconds={0} onJump={vi.fn()} />)
    expect(container.querySelector('svg')).not.toBeNull()
  })

  it('(c) clicking the pill calls onJump', () => {
    const onJump = vi.fn()
    render(<JumpPill seconds={0} onJump={onJump} />)
    fireEvent.click(screen.getByRole('button', { name: /jump to now/i }))
    expect(onJump).toHaveBeenCalledOnce()
  })
})
