// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import { useExcerptStore } from './excerptState'

describe('excerptState', () => {
  beforeEach(() => {
    useExcerptStore.getState().clear()
  })

  it('starts empty', () => {
    expect(useExcerptStore.getState().pending).toBeNull()
  })

  it('set stores the pending excerpt', () => {
    useExcerptStore.getState().set({
      text: 'the quote',
      locator: {
        media: 'pdf',
        pdf_id: 'p',
        page: 1,
        rect: [0, 0, 1, 1],
        quote: 'the quote',
        prefix: '',
        suffix: '',
      },
      pdfId: 'p',
      page: 1,
    })
    expect(useExcerptStore.getState().pending?.text).toBe('the quote')
  })

  it('starts unarmed; arm() is a no-op with nothing pending', () => {
    expect(useExcerptStore.getState().armed).toBe(false)
    useExcerptStore.getState().arm()
    expect(useExcerptStore.getState().armed).toBe(false)
  })

  it('selection (set) never arms; only an explicit arm() does', () => {
    useExcerptStore.getState().set({ text: 'q', locator: {} as never, pdfId: 'p', page: 1 })
    expect(useExcerptStore.getState().armed).toBe(false) // B3: selecting text must not arm placement
    useExcerptStore.getState().arm()
    expect(useExcerptStore.getState().armed).toBe(true)
  })

  it('a new selection (set) resets armed back to false', () => {
    useExcerptStore.getState().set({ text: 'a', locator: {} as never, pdfId: 'p', page: 1 })
    useExcerptStore.getState().arm()
    useExcerptStore.getState().set({ text: 'b', locator: {} as never, pdfId: 'p', page: 1 })
    expect(useExcerptStore.getState().armed).toBe(false)
  })

  it('clear resets pending and armed', () => {
    useExcerptStore.getState().set({ text: 'x', locator: {} as never, pdfId: 'p', page: 1 })
    useExcerptStore.getState().arm()
    useExcerptStore.getState().clear()
    expect(useExcerptStore.getState().pending).toBeNull()
    expect(useExcerptStore.getState().armed).toBe(false)
  })
})
