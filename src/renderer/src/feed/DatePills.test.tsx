import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { DayDivider, ScrollDatePill } from './DatePills'

describe('DayDivider', () => {
  it('shows its label', () => {
    render(<DayDivider label="June 2" />)
    expect(screen.getByText('June 2')).toBeInTheDocument()
  })
})

describe('ScrollDatePill', () => {
  it('is opaque and translated by -push when visible', () => {
    render(<ScrollDatePill label="today" push={12} visible />)
    const pill = screen.getByText('today').parentElement as HTMLElement
    expect(pill.style.opacity).toBe('1')
    expect(pill.style.transform).toBe('translateY(-12px)')
  })

  it('fades (opacity 0) when not visible', () => {
    render(<ScrollDatePill label="today" push={0} visible={false} />)
    const pill = screen.getByText('today').parentElement as HTMLElement
    expect(pill.style.opacity).toBe('0')
  })
})
