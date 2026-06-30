import { fireEvent, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { renderWithProviders as render } from '../../../../tests/setup'
import { Composer } from './Composer'

describe('Composer', () => {
  it('Enter submits with mode=claim by default', () => {
    const onSubmit = vi.fn()
    render(<Composer onSubmit={onSubmit} initialBody="" initialMode="claim" onCancel={() => {}} />)
    const ta = screen.getByRole('textbox')
    fireEvent.change(ta, { target: { value: 'hello' } })
    fireEvent.keyDown(ta, { key: 'Enter' })
    expect(onSubmit).toHaveBeenCalledWith({ body: 'hello', type: 'claim' })
  })

  it('the send button submits with mode=claim', () => {
    const onSubmit = vi.fn()
    render(<Composer onSubmit={onSubmit} initialBody="" initialMode="claim" onCancel={() => {}} />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'hi' } })
    fireEvent.click(screen.getByRole('button', { name: /send note/i }))
    expect(onSubmit).toHaveBeenCalledWith({ body: 'hi', type: 'claim' })
  })

  it('Shift+Enter inserts a newline (does not submit)', () => {
    const onSubmit = vi.fn()
    render(<Composer onSubmit={onSubmit} initialBody="" initialMode="claim" onCancel={() => {}} />)
    const ta = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.change(ta, { target: { value: 'a' } })
    fireEvent.keyDown(ta, { key: 'Enter', shiftKey: true })
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('? on an empty composer flips mode to question', () => {
    render(<Composer onSubmit={() => {}} initialBody="" initialMode="claim" onCancel={() => {}} />)
    const ta = screen.getByRole('textbox')
    fireEvent.keyDown(ta, { key: '?' })
    expect(screen.getByText(/question/i)).toBeInTheDocument()
  })

  it('? on a non-empty composer is a literal character (no mode flip)', () => {
    const onSubmit = vi.fn()
    render(<Composer onSubmit={onSubmit} initialBody="" initialMode="claim" onCancel={() => {}} />)
    const ta = screen.getByRole('textbox')
    fireEvent.change(ta, { target: { value: 'hello' } })
    fireEvent.keyDown(ta, { key: '?' })
    // Pill text is "QUESTION — ESC TO CLEAR"; /question/i matches it when in
    // question mode, and is absent when in claim mode.
    expect(screen.queryByText(/question/i)).not.toBeInTheDocument()
  })

  it('Esc in question mode drops back to claim', () => {
    render(<Composer onSubmit={() => {}} initialBody="" initialMode="claim" onCancel={() => {}} />)
    const ta = screen.getByRole('textbox')
    fireEvent.keyDown(ta, { key: '?' })
    fireEvent.keyDown(ta, { key: 'Escape' })
    expect(screen.queryByText(/question/i)).not.toBeInTheDocument()
  })

  it('Esc when there is a body in edit mode calls onCancel', () => {
    const onCancel = vi.fn()
    render(
      <Composer
        onSubmit={() => {}}
        initialBody="prefilled"
        initialMode="claim"
        onCancel={onCancel}
        editMode
      />,
    )
    const ta = screen.getByRole('textbox')
    fireEvent.keyDown(ta, { key: 'Escape' })
    expect(onCancel).toHaveBeenCalledOnce()
  })

  // The 3 tests below assert React SyntheticEvent.stopPropagation() by
  // wrapping the Composer in a parent <div onKeyDown> sentinel: if the child
  // calls e.stopPropagation(), the parent React handler never fires. This is
  // the most reliable detector for React 19 — `fireEvent.keyDown(node, {
  // stopPropagation: spy })` does NOT spy on React's SyntheticEvent method
  // (the spy is attached to the native event init, not the SyntheticEvent
  // wrapper that React constructs at dispatch time).
  it('Esc in question mode stops propagation (so global handler does not also fire)', () => {
    let bubbled = false
    render(
      // biome-ignore lint/a11y/noStaticElementInteractions: test sentinel only.
      <div
        onKeyDown={() => {
          bubbled = true
        }}
      >
        <Composer onSubmit={() => {}} initialBody="" initialMode="claim" onCancel={() => {}} />
      </div>,
    )
    const ta = screen.getByRole('textbox')
    fireEvent.keyDown(ta, { key: '?' })
    bubbled = false // discard the '?' keydown which legitimately bubbles
    fireEvent.keyDown(ta, { key: 'Escape' })
    expect(bubbled).toBe(false)
  })

  it('Esc in edit mode stops propagation', () => {
    let bubbled = false
    render(
      // biome-ignore lint/a11y/noStaticElementInteractions: test sentinel only.
      <div
        onKeyDown={() => {
          bubbled = true
        }}
      >
        <Composer
          onSubmit={() => {}}
          initialBody="prefilled"
          initialMode="claim"
          onCancel={() => {}}
          editMode
        />
      </div>,
    )
    const ta = screen.getByRole('textbox')
    fireEvent.keyDown(ta, { key: 'Escape' })
    expect(bubbled).toBe(false)
  })

  it('renders the `error` prop inside a role=alert region for screen readers', () => {
    render(
      <Composer
        onSubmit={() => {}}
        initialBody="abc"
        initialMode="claim"
        onCancel={() => {}}
        error={'a note named "abc" already exists'}
      />,
    )
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('a note named "abc" already exists')
  })

  it('calls onClearError on the next keystroke when an error is present', () => {
    const onClearError = vi.fn()
    render(
      <Composer
        onSubmit={() => {}}
        initialBody="abc"
        initialMode="claim"
        onCancel={() => {}}
        error="dup!"
        onClearError={onClearError}
      />,
    )
    const ta = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.change(ta, { target: { value: 'abcd' } })
    expect(onClearError).toHaveBeenCalledOnce()
  })

  it('does NOT call onClearError on keystroke when error is null', () => {
    const onClearError = vi.fn()
    render(
      <Composer
        onSubmit={() => {}}
        initialBody=""
        initialMode="claim"
        onCancel={() => {}}
        error={null}
        onClearError={onClearError}
      />,
    )
    const ta = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.change(ta, { target: { value: 'a' } })
    expect(onClearError).not.toHaveBeenCalled()
  })

  it('does NOT clear body text on submit — parent owns success-clear via remount', () => {
    // The mutation is async in App.tsx; the composer can't know synchronously
    // whether the submit succeeded. Clearing pre-emptively would wipe the
    // user's text on a failure (e.g. duplicate-slug rejection). Parent
    // remounts this Composer via key-bump on success to get a fresh
    // `initialBody=''`; on failure, the key stays, this state stays. See #23.
    const onSubmit = vi.fn()
    render(<Composer onSubmit={onSubmit} initialBody="" initialMode="claim" onCancel={() => {}} />)
    const ta = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.change(ta, { target: { value: 'abc' } })
    fireEvent.keyDown(ta, { key: 'Enter' })
    expect(onSubmit).toHaveBeenCalledWith({ body: 'abc', type: 'claim' })
    expect(ta.value).toBe('abc')
  })

  // B13 / ADR 0047: the feed-view composer must share the feed's "Model A" band so
  // they move + shrink as one unit. The band div is the textarea's grandparent
  // (textarea → card → band → outer-padding).
  const bandDiv = (ta: HTMLElement): HTMLElement => ta.parentElement?.parentElement as HTMLElement

  it('B13: with no band, the composer keeps the default centered 720 band', () => {
    render(<Composer onSubmit={() => {}} initialBody="" initialMode="claim" onCancel={() => {}} />)
    const band = bandDiv(screen.getByRole('textbox'))
    expect(band.style.maxWidth).toBe('720px')
    expect(band.style.margin).toBe('0px auto') // centered in its column
    // Outer keeps its symmetric 32px horizontal padding.
    expect((band.parentElement as HTMLElement).style.paddingLeft).toBe('32px')
  })

  it('B13: with a band, the composer adopts the band maxWidth + margins (shares the feed band)', () => {
    render(
      <Composer
        onSubmit={() => {}}
        initialBody=""
        initialMode="claim"
        onCancel={() => {}}
        band={{ maxWidth: 500, marginLeft: 0, marginRight: 0 }}
      />,
    )
    const band = bandDiv(screen.getByRole('textbox'))
    expect(band.style.maxWidth).toBe('500px')
    expect(band.style.marginLeft).toBe('0px')
    expect(band.style.marginRight).toBe('0px')
    // Outer surrenders horizontal padding to the band's gutters.
    expect((band.parentElement as HTMLElement).style.paddingLeft).toBe('0px')
  })

  it('Esc in plain claim mode (no edit, no question) does NOT stopPropagation — lets global handler fire', () => {
    let bubbled = false
    render(
      // biome-ignore lint/a11y/noStaticElementInteractions: test sentinel only.
      <div
        onKeyDown={() => {
          bubbled = true
        }}
      >
        <Composer onSubmit={() => {}} initialBody="" initialMode="claim" onCancel={() => {}} />
      </div>,
    )
    const ta = screen.getByRole('textbox')
    fireEvent.keyDown(ta, { key: 'Escape' })
    expect(bubbled).toBe(true)
  })
})
