import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Markdown } from './markdown'

describe('Markdown', () => {
  it('renders plain markdown', () => {
    const { container } = render(<Markdown body="hello **world**" onWikilinkClick={() => {}} />)
    expect(container.innerHTML).toContain('<strong>world</strong>')
  })

  it('renders [[wikilink]] as a clickable element with data-slug', () => {
    const { container } = render(<Markdown body="see [[target]]" onWikilinkClick={() => {}} />)
    const link = container.querySelector('a.wikilink') as HTMLAnchorElement
    expect(link).toBeTruthy()
    expect(link.dataset.slug).toBe('target')
    expect(link.textContent).toBe('target')
  })

  it('renders [[target|display]] with display text and target slug', () => {
    const { container } = render(<Markdown body="[[a|alpha]]" onWikilinkClick={() => {}} />)
    const link = container.querySelector('a.wikilink') as HTMLAnchorElement
    expect(link.dataset.slug).toBe('a')
    expect(link.textContent).toBe('alpha')
  })

  it('renders inline math via KaTeX', () => {
    const { container } = render(<Markdown body="$x^2$" onWikilinkClick={() => {}} />)
    expect(container.querySelector('.katex')).toBeTruthy()
  })

  it('adds class="dangling" + tooltip when resolveSlug returns false', () => {
    const { container } = render(
      <Markdown body="see [[no-such]]" onWikilinkClick={() => {}} resolveSlug={() => false} />,
    )
    const link = container.querySelector('a.wikilink') as HTMLAnchorElement
    expect(link.classList.contains('dangling')).toBe(true)
    expect(link.title).toBe('not a note yet — click to start one.')
  })

  it('no .dangling class when resolveSlug returns true', () => {
    const { container } = render(
      <Markdown body="see [[live]]" onWikilinkClick={() => {}} resolveSlug={() => true} />,
    )
    const link = container.querySelector('a.wikilink') as HTMLAnchorElement
    expect(link.classList.contains('dangling')).toBe(false)
  })
})
