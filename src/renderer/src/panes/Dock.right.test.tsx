import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderWithProviders } from '../../../../tests/setup'
import { Dock } from './Dock'
import type { Pane } from './Pane'
import * as PaneModule from './Pane'

// One content pane (right home) and one utility pane (left home). We spy on the
// real getPane PER TEST rather than vi.mock('./Pane'): the dom project runs with
// `isolate: false` (vitest.config.ts), so a hoisted module mock of ./Pane races
// with the other renderer suites that import the real registry — intermittently
// the mock doesn't apply and the real ShelfPaneBody (which needs a QueryClient)
// renders. An imperative spyOn is re-applied every test and restored in
// afterEach, so it's deterministic regardless of file order in the worker.
const contentPane: Pane = {
  id: 'pdf',
  title: 'pdf',
  homeDock: 'right',
  kind: 'content',
  render: () => <div>pdf body</div>,
}
const utilityPane: Pane = {
  id: 'shelf',
  title: 'shelf',
  homeDock: 'left',
  kind: 'utility',
  render: () => <div>shelf body</div>,
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Dock side', () => {
  it('renders a content pane on the right with the wide default width (600)', () => {
    vi.spyOn(PaneModule, 'getPane').mockReturnValue(contentPane)
    const { container } = renderWithProviders(
      <Dock open paneId="pdf" onClose={() => {}} side="right" />,
    )
    const aside = container.querySelector<HTMLElement>('[data-dock="right"]')
    expect(aside).not.toBeNull()
    expect(aside?.getAttribute('data-dock')).toBe('right')
    // Content clamp default = 600 (utility default is 280) — proves the wider clamp.
    expect(aside?.style.width).toBe('600px')
    // Right dock: border + resize handle sit on the inner (left) edge.
    expect(aside?.getAttribute('style')).toContain('border-left')
    expect(aside?.getAttribute('style')).not.toContain('border-right')
    const handle = aside?.querySelector<HTMLElement>('[data-dock-resize]')
    expect(handle?.style.left).toBe('-3px')
    expect(handle?.style.right).toBe('')
  })

  it('renders a utility pane on the left with the narrow default width (280)', () => {
    vi.spyOn(PaneModule, 'getPane').mockReturnValue(utilityPane)
    const { container } = renderWithProviders(
      <Dock open paneId="shelf" onClose={() => {}} side="left" />,
    )
    const aside = container.querySelector<HTMLElement>('[data-dock="left"]')
    expect(aside).not.toBeNull()
    // Utility clamp default = 280 — unchanged from v0.4.
    expect(aside?.style.width).toBe('280px')
    expect(aside?.getAttribute('style')).toContain('border-right')
    expect(aside?.getAttribute('style')).not.toContain('border-left')
    const handle = aside?.querySelector<HTMLElement>('[data-dock-resize]')
    expect(handle?.style.right).toBe('-3px')
  })

  it('defaults side to "left" when the prop is omitted (backward compatible)', () => {
    vi.spyOn(PaneModule, 'getPane').mockReturnValue(utilityPane)
    const { container } = renderWithProviders(<Dock open paneId="shelf" onClose={() => {}} />)
    expect(container.querySelector('[data-dock="left"]')).not.toBeNull()
  })
})
