import { fireEvent, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { renderWithProviders as render } from '../../../../tests/setup'
import { Markdown } from './markdown'

describe('Markdown', () => {
  it('renders plain markdown', () => {
    const { container } = render(<Markdown body="hello **world**" onWikilinkClick={() => {}} />)
    expect(container.innerHTML).toContain('<strong>world</strong>')
  })

  describe('yt-timestamps', () => {
    it('renders @1:23 as an a.yt-ts anchor with data-seconds="83"', () => {
      const { container } = render(
        <Markdown body="see @1:23" onWikilinkClick={() => {}} onYtSeek={() => {}} />,
      )
      const link = container.querySelector('a.yt-ts') as HTMLAnchorElement
      expect(link).toBeTruthy()
      expect(link.dataset.seconds).toBe('83')
    })

    it('click on a.yt-ts calls onYtSeek(83) and prevents default', () => {
      const onYtSeek = vi.fn()
      const { container } = render(
        <Markdown body="see @1:23" onWikilinkClick={() => {}} onYtSeek={onYtSeek} />,
      )
      const link = container.querySelector('a.yt-ts') as HTMLAnchorElement
      const ev = new MouseEvent('click', { bubbles: true, cancelable: true })
      link.dispatchEvent(ev)
      expect(onYtSeek).toHaveBeenCalledExactlyOnceWith(83)
      expect(ev.defaultPrevented).toBe(true)
    })

    it('click on a.yt-ts does NOT call onWikilinkClick', () => {
      const onWikilinkClick = vi.fn()
      const onYtSeek = vi.fn()
      const { container } = render(
        <Markdown body="see @1:23" onWikilinkClick={onWikilinkClick} onYtSeek={onYtSeek} />,
      )
      const link = container.querySelector('a.yt-ts') as HTMLAnchorElement
      const ev = new MouseEvent('click', { bubbles: true, cancelable: true })
      link.dispatchEvent(ev)
      expect(onWikilinkClick).not.toHaveBeenCalled()
    })

    it('wikilink click still works when yt-ts is also present (no regression)', () => {
      const onWikilinkClick = vi.fn()
      const onYtSeek = vi.fn()
      const { container } = render(
        <Markdown
          body="see [[target]] at @0:42"
          onWikilinkClick={onWikilinkClick}
          onYtSeek={onYtSeek}
        />,
      )
      const wikilink = container.querySelector('a.wikilink') as HTMLAnchorElement
      const ev = new MouseEvent('click', { bubbles: true, cancelable: true })
      wikilink.dispatchEvent(ev)
      expect(onWikilinkClick).toHaveBeenCalledExactlyOnceWith('target')
      expect(onYtSeek).not.toHaveBeenCalled()
    })
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

  it('renders inline math via KaTeX (lazily, after paint — see #53)', async () => {
    const { container } = render(<Markdown body="$x^2$" onWikilinkClick={() => {}} />)
    // KaTeX now renders imperatively after the markdown paints (deferred to
    // idle/rAF) so it doesn't block the synchronous render / morph. See #53.
    await waitFor(() => expect(container.querySelector('.katex')).toBeTruthy())
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

  it('click on wikilink calls onWikilinkClick with normalized slug and preventDefault', () => {
    const onWikilinkClick = vi.fn()
    const { container } = render(
      <Markdown body="see [[Some Target]]" onWikilinkClick={onWikilinkClick} />,
    )
    const link = container.querySelector('a.wikilink') as HTMLAnchorElement
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true })
    link.dispatchEvent(ev)
    expect(onWikilinkClick).toHaveBeenCalledExactlyOnceWith('some target')
    expect(ev.defaultPrevented).toBe(true)
  })

  it('click on a regular markdown link does NOT call onWikilinkClick', () => {
    const onWikilinkClick = vi.fn()
    const { container } = render(
      <Markdown body="[plain](https://example.com)" onWikilinkClick={onWikilinkClick} />,
    )
    const link = container.querySelector('a:not(.wikilink)') as HTMLAnchorElement
    fireEvent.click(link)
    expect(onWikilinkClick).not.toHaveBeenCalled()
  })
})
