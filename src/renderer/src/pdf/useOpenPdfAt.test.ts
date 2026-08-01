import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { beforeEach, describe, expect, it } from 'vitest'
import { installMockApi, type MockApi } from '../../../../tests/setup'
import type { PdfLocator } from '../../../shared/types'
import { useDockStore } from '../panes/dockStore'
import { usePendingJumpStore } from './pendingJumpState'
import { useOpenPdfAt } from './useOpenPdfAt'

const LOCATOR: PdfLocator = {
  media: 'pdf',
  pdf_id: 'doc-a',
  page: 12,
  rect: [100, 200, 50, 20],
  quote: 'the selected text',
}

const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(
    QueryClientProvider,
    { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
    children,
  )

let mockApi: MockApi
beforeEach(() => {
  mockApi = installMockApi()
  usePendingJumpStore.setState({ pending: null })
  // The dock store is module-scoped zustand, and the renderer vitest project runs
  // `isolate: false` (vitest.config.ts) — so reset it explicitly, or `openPane`
  // is a no-op left over from a prior file rather than an observable transition.
  useDockStore.getState().reset()
})

describe('useOpenPdfAt', () => {
  it('writes pdf.openDocId AND opens the pdf pane (the pair App used to own)', async () => {
    const { result } = renderHook(() => useOpenPdfAt(), { wrapper })

    result.current('doc-a')

    // openPane is synchronous — the dock must not wait on the SQLite write.
    expect(useDockStore.getState().right.openPaneIds).toContain('pdf')
    await waitFor(() =>
      expect(mockApi.settings.set).toHaveBeenCalledWith({ key: 'pdf.openDocId', value: 'doc-a' }),
    )
  })

  it('queues a pending jump when a locator is passed', () => {
    const { result } = renderHook(() => useOpenPdfAt(), { wrapper })

    result.current('doc-a', LOCATOR)

    expect(usePendingJumpStore.getState().pending).toEqual({ pdfId: 'doc-a', locator: LOCATOR })
  })

  it('queues NOTHING without a locator, so a plain open restores the last position', () => {
    // Spec §6: an ordinary open must fall through to the persisted-position
    // restore. A jump queued here would beat it and pin the reader at page 1.
    const { result } = renderHook(() => useOpenPdfAt(), { wrapper })

    result.current('doc-a')

    expect(usePendingJumpStore.getState().pending).toBeNull()
  })

  it('queues the jump BEFORE the async openDocId write settles', async () => {
    // The reader drains on the document change that write causes, so a jump
    // queued after it could arrive too late. Asserting ordering, not just presence:
    // the store is already populated on the synchronous return.
    const { result } = renderHook(() => useOpenPdfAt(), { wrapper })

    result.current('doc-b', LOCATOR)

    expect(usePendingJumpStore.getState().pending?.pdfId).toBe('doc-b')
    expect(mockApi.settings.set).not.toHaveBeenCalled() // mutateAsync has not resolved yet
    await waitFor(() => expect(mockApi.settings.set).toHaveBeenCalled())
  })

  it('is stable across renders (safe as a NoteBubble callback dep)', () => {
    const { result, rerender } = renderHook(() => useOpenPdfAt(), { wrapper })
    const first = result.current
    rerender()
    expect(result.current).toBe(first)
  })
})
