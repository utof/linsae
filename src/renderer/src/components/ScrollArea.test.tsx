import { screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { renderWithProviders as render } from '../../../../tests/setup'
import { ScrollArea } from './ScrollArea'

describe('ScrollArea', () => {
  it('renders children inside the inner scroll container', () => {
    render(
      <ScrollArea>
        <div data-testid="payload">hello</div>
      </ScrollArea>,
    )
    expect(screen.getByTestId('payload')).toBeInTheDocument()
  })

  it('inner scroll container has the .scroll-area-inner class for native-scrollbar hiding', () => {
    const { container } = render(
      <ScrollArea>
        <div>hello</div>
      </ScrollArea>,
    )
    const inner = container.querySelector('.scroll-area-inner')
    expect(inner).toBeInTheDocument()
  })

  it('does not render the thumb when content is not overflowing (thumbHeight === 0)', () => {
    // jsdom returns 0 for layout measurements so scrollHeight === clientHeight,
    // which the hook treats as "not overflowing" → thumb suppressed. The
    // thumb is the only absolute-positioned sibling of the inner scroll
    // container; with no overflow, it should not be in the DOM.
    const { container } = render(
      <ScrollArea>
        <div>short</div>
      </ScrollArea>,
    )
    const absChildren = container.querySelectorAll('[aria-hidden="true"]')
    expect(absChildren.length).toBe(0)
  })

  it('mounts and unmounts cleanly (effect cleanup runs without throwing)', () => {
    const { unmount } = render(
      <ScrollArea>
        <div>hello</div>
      </ScrollArea>,
    )
    // Unmount runs the useEffect cleanup; if listener removal or timer
    // clearTimeout throws, the test fails.
    expect(() => unmount()).not.toThrow()
  })
})
