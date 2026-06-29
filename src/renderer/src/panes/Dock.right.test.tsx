import { render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Dock } from './Dock'
import * as PaneModule from './Pane'

beforeEach(() => {
  vi.spyOn(PaneModule, 'getPane').mockImplementation((id: string) => ({
    id,
    title: id,
    homeDock: 'right',
    kind: 'content',
    render: () => <div>{id} body</div>,
  }))
})
afterEach(() => vi.restoreAllMocks())

const base = {
  openPaneIds: ['pdf'],
  activeId: 'pdf',
  onActivate: vi.fn(),
  onClose: vi.fn(),
  onWidthChange: vi.fn(),
}

describe('Dock side mirroring', () => {
  it('right dock borders on the left; left dock borders on the right', () => {
    const { container: r } = render(<Dock {...base} side="right" width={600} />)
    const { container: l } = render(<Dock {...base} side="left" width={280} />)
    // Read the raw inline style string: happy-dom's CSSOM `style.borderLeft`
    // getter mangles the `1px solid var(--border-0)` shorthand (drops the 1px),
    // so assert side-mirroring against the serialized attribute instead.
    const right = r.querySelector('[data-dock="right"]') as HTMLElement
    const left = l.querySelector('[data-dock="left"]') as HTMLElement
    expect(right.getAttribute('style')).toContain('border-left')
    expect(right.getAttribute('style')).not.toContain('border-right')
    expect(left.getAttribute('style')).toContain('border-right')
    expect(left.getAttribute('style')).not.toContain('border-left')
  })
  it('renders the controlled width prop verbatim', () => {
    const { container } = render(<Dock {...base} side="right" width={742} />)
    expect((container.querySelector('[data-dock="right"]') as HTMLElement).style.width).toBe(
      '742px',
    )
  })
})
