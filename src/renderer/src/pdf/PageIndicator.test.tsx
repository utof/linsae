import { fireEvent, render } from '@testing-library/react'
import { act, createRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PageIndicator, type PageIndicatorHandle } from './PageIndicator'

/** Matches `IDLE_MS` in PageIndicator.tsx — the fade-on-idle window. */
const IDLE_MS = 800
const NUM_PAGES = 517

function mount(onJump = vi.fn()) {
  const ref = createRef<PageIndicatorHandle>()
  const { container } = render(<PageIndicator ref={ref} numPages={NUM_PAGES} onJump={onJump} />)
  const pill = (): HTMLElement | null =>
    container.querySelector('[data-testid="pdf-page-indicator"]')
  const input = (): HTMLInputElement | null =>
    container.querySelector('[data-testid="pdf-page-input"]')
  /** The wrapper that carries the fade — the pill's own parent. */
  const opacity = (): string => ((pill() ?? input())?.parentElement as HTMLElement).style.opacity
  const report = (page: number) => act(() => ref.current?.report(page))
  const openEditor = () => {
    fireEvent.click(pill() as HTMLElement)
  }
  return { container, onJump, pill, input, opacity, report, openEditor }
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('PageIndicator', () => {
  it('renders "page / numPages", starting at page 1', () => {
    const { pill } = mount()
    expect(pill()?.textContent).toBe(`1 / ${NUM_PAGES}`)
  })

  it('shows the page the reader reports', () => {
    const { pill, report } = mount()

    report(42)

    // The derivation under test is the reader's (`anchorRef.page` → this string); an
    // off-by-one anywhere along it lands here.
    expect(pill()?.textContent).toBe(`42 / ${NUM_PAGES}`)
  })

  it('recedes once scrolling stops, and re-lights on the next report', () => {
    const { opacity, report } = mount()

    report(42)
    expect(opacity()).toBe('1')

    act(() => {
      vi.advanceTimersByTime(IDLE_MS + 50)
    })
    // Receded but NOT gone. `opacity: 0` does not disable hit-testing, so a fully
    // transparent pill would still swallow clicks in the corner of the reader — and
    // making it click-through as well would leave jump-to-page unreachable. Asserting
    // the interval rather than the literal value: what must hold is "dimmer, still
    // there", not one particular number.
    expect(Number(opacity())).toBeLessThan(1)
    expect(Number(opacity())).toBeGreaterThan(0)

    report(43)
    expect(opacity()).toBe('1')
  })

  it('opens a number input seeded with the current page when clicked', () => {
    const { pill, input, report, openEditor } = mount()
    report(42)

    openEditor()

    expect(pill()).toBeNull() // the counter is replaced, not duplicated
    expect(input()?.value).toBe('42')
  })

  it('commits the typed page on Enter', () => {
    const { input, onJump, openEditor, pill } = mount()
    openEditor()

    fireEvent.change(input() as HTMLInputElement, { target: { value: '300' } })
    fireEvent.keyDown(input() as HTMLInputElement, { key: 'Enter' })

    expect(onJump).toHaveBeenCalledWith(300)
    expect(pill()).not.toBeNull() // …and returns to display mode
  })

  it('hands an OUT-OF-RANGE entry straight through — the reader owns the clamp', () => {
    // Pinning the contract, not an oversight: clamping here as well would leave two
    // clamps to keep in step, and the reader's is the load-bearing one (an
    // out-of-range page makes `readAnchorItem` return null and the jump a silent
    // no-op). `PdfReader.test.tsx` asserts the landing.
    const { input, onJump, openEditor } = mount()
    openEditor()

    fireEvent.change(input() as HTMLInputElement, { target: { value: '9999' } })
    fireEvent.keyDown(input() as HTMLInputElement, { key: 'Enter' })

    expect(onJump).toHaveBeenCalledWith(9999)
  })

  it('cancels on Escape without jumping', () => {
    const { input, onJump, pill, report, openEditor } = mount()
    report(42)
    openEditor()
    fireEvent.change(input() as HTMLInputElement, { target: { value: '300' } })

    fireEvent.keyDown(input() as HTMLInputElement, { key: 'Escape' })

    expect(onJump).not.toHaveBeenCalled()
    expect(pill()?.textContent).toBe(`42 / ${NUM_PAGES}`) // still where the reader is
  })

  it('cancels on blur (clicking away is not a commit)', () => {
    const { input, onJump, pill, openEditor } = mount()
    openEditor()
    fireEvent.change(input() as HTMLInputElement, { target: { value: '300' } })

    fireEvent.blur(input() as HTMLInputElement)

    expect(onJump).not.toHaveBeenCalled()
    expect(pill()).not.toBeNull()
  })

  it('treats a blank entry as a cancel, not a jump to page 1', () => {
    // `Number.parseInt('')` is NaN, and NaN clamps to 1 downstream — so without the
    // finite guard, clearing the box and pressing Enter would teleport the reader to
    // the top of the document for what the user experienced as a no-op.
    const { input, onJump, openEditor } = mount()
    openEditor()

    fireEvent.change(input() as HTMLInputElement, { target: { value: '' } })
    fireEvent.keyDown(input() as HTMLInputElement, { key: 'Enter' })

    expect(onJump).not.toHaveBeenCalled()
  })

  it('stays lit while the editor is open, however long the user takes to type', () => {
    const { opacity, report, openEditor } = mount()
    report(42)
    openEditor()

    act(() => {
      vi.advanceTimersByTime(IDLE_MS * 3)
    })

    expect(opacity()).toBe('1')
  })
})
