import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useExcerptStore } from './excerptState'
import { useExcerptCapture } from './useExcerptCapture'

function stubSelection(text: string): void {
  const range = {
    getClientRects: () => [{ left: 10, top: 10, right: 60, bottom: 30, width: 50, height: 20 }],
  }
  vi.spyOn(window, 'getSelection').mockReturnValue({
    isCollapsed: false,
    rangeCount: 1,
    toString: () => text,
    getRangeAt: () => range,
  } as unknown as Selection)
}

describe('useExcerptCapture', () => {
  beforeEach(() => {
    useExcerptStore.getState().clear()
    vi.restoreAllMocks()
  })

  it('on mouseup with a non-empty selection, stores a pending excerpt with a non-empty quote — but does NOT arm', async () => {
    const pageEl = document.createElement('div')
    document.body.appendChild(pageEl)
    const page = {
      pageNumber: 3,
      getTextContent: vi
        .fn()
        .mockResolvedValue({ items: [{ str: 'before the selected text after' }] }),
    }
    const viewport = { convertToPdfPoint: (x: number, y: number) => [x, y] as [number, number] }
    stubSelection('the selected text')

    renderHook(() =>
      useExcerptCapture({
        pdfId: 'pdf-1',
        page: page as never,
        viewport: viewport as never,
        pageEl,
      }),
    )
    pageEl.dispatchEvent(new MouseEvent('mouseup'))

    await vi.waitFor(() => {
      const p = useExcerptStore.getState().pending
      expect(p).not.toBeNull()
      expect(p?.locator.quote).toBe('the selected text')
      expect(p?.locator.media).toBe('pdf')
      expect(p?.page).toBe(3)
      expect(p?.locator.prefix).toBe('before ')
      expect(p?.locator.suffix).toBe(' after')
      expect(p?.locator.textStart).toBe(7)
      expect(p?.locator.textEnd).toBe(24)
    })
    // B3: selecting text must never arm placement (that's the affordance's job).
    expect(useExcerptStore.getState().armed).toBe(false)
  })

  it('ignores a collapsed selection (no pending stored)', async () => {
    const pageEl = document.createElement('div')
    document.body.appendChild(pageEl)
    const page = { pageNumber: 1, getTextContent: vi.fn().mockResolvedValue({ items: [] }) }
    const viewport = { convertToPdfPoint: (x: number, y: number) => [x, y] as [number, number] }
    vi.spyOn(window, 'getSelection').mockReturnValue({
      isCollapsed: true,
      rangeCount: 0,
    } as unknown as Selection)

    renderHook(() =>
      useExcerptCapture({ pdfId: 'p', page: page as never, viewport: viewport as never, pageEl }),
    )
    pageEl.dispatchEvent(new MouseEvent('mouseup'))
    await Promise.resolve()
    expect(useExcerptStore.getState().pending).toBeNull()
  })
})
