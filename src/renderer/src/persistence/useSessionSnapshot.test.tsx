// @vitest-environment happy-dom
/**
 * Component-level test for `useSessionSnapshot`.
 *
 * Mirrors the repo's react-query hook-test convention — a local
 * `QueryClientProvider` wrapper (`makeWrapper`) + `installMockApi` — as used by
 * useThreadNotes.test.tsx / use-setting.test.tsx. There is no shared `renderHook`
 * helper (`renderWithProviders` wraps `render`, not `renderHook`).
 *
 * @see src/renderer/src/persistence/useSessionSnapshot.ts
 * @see docs/specs/v0.7-session-persistence.md §Architecture
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it } from 'vitest'
import { installMockApi } from '../../../../tests/setup'
import { useSessionSnapshot } from './useSessionSnapshot'

function makeWrapper(): ({ children }: { children: ReactNode }) => ReactNode {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  )
}

describe('useSessionSnapshot', () => {
  let mock: ReturnType<typeof installMockApi>

  beforeEach(() => {
    mock = installMockApi()
  })

  it('safe-parses each key: valid passes through, malformed → default, absent → default', async () => {
    mock.settings.getMany.mockResolvedValue({
      values: {
        // valid ui.session payload
        'ui.session.v1': { focusedNoteId: 'n1', threadNoteId: null },
        // malformed: a string where a record is expected
        'thread.scroll.v1': 'not-an-object',
      },
    })

    const { result } = renderHook(() => useSessionSnapshot(), { wrapper: makeWrapper() })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    // Valid value parses through unchanged.
    expect(result.current.data?.uiSession).toEqual({ focusedNoteId: 'n1', threadNoteId: null })
    // Load-bearing: raw passthrough would leave the string 'not-an-object' here; the
    // safeParseOr fallback to `{}` is what makes this assertion meaningful.
    expect(result.current.data?.threadScroll).toEqual({})
    // Absent key falls back to its `null` default (dock.layout.v1 was never returned).
    expect(result.current.data?.dockLayout).toBeNull()
  })
})
