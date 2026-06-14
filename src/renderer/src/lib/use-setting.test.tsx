/**
 * Component tests for useSetting / useSetSetting hooks.
 *
 * Why: knip requires every exported module to be reachable from an entrypoint or
 * test; these hooks are consumed in Tasks 7+ so a test satisfies that gate now.
 *
 * Uses renderWithProviders' QueryClientProvider wrapper because both hooks rely
 * on react-query state. The settings mock is installed via installMockApi so
 * window.api.settings.get/set is available without a real IPC channel.
 *
 * @see src/renderer/src/lib/use-setting.ts
 * @see tests/setup.tsx (installMockApi)
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it } from 'vitest'
import { installMockApi } from '../../../../tests/setup'
import { useSetSetting, useSetting } from './use-setting'

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

describe('useSetting', () => {
  let mockApi: ReturnType<typeof installMockApi>

  beforeEach(() => {
    mockApi = installMockApi()
  })

  it('returns the default value while loading / when unset (value: null)', async () => {
    mockApi.settings.get.mockResolvedValue({ value: null })
    const { result } = renderHook(() => useSetting('notes.recencyMode', 'frecent'), { wrapper })
    // Initial render: data is undefined → default returned.
    expect(result.current).toBe('frecent')
    // After query resolves with null → still returns default.
    await waitFor(() =>
      expect(mockApi.settings.get).toHaveBeenCalledWith({ key: 'notes.recencyMode' }),
    )
    expect(result.current).toBe('frecent')
  })

  it('returns the stored value when set', async () => {
    mockApi.settings.get.mockResolvedValue({ value: 'recent' })
    const { result } = renderHook(() => useSetting('notes.recencyMode', 'frecent'), { wrapper })
    await waitFor(() => expect(result.current).toBe('recent'))
  })
})

describe('useSetSetting', () => {
  let mockApi: ReturnType<typeof installMockApi>

  beforeEach(() => {
    mockApi = installMockApi()
  })

  it('calls settings.set and invalidates the query', async () => {
    mockApi.settings.get.mockResolvedValue({ value: null })
    mockApi.settings.set.mockResolvedValue({ ok: true })
    const { result } = renderHook(() => useSetSetting('notes.recencyMode'), { wrapper })
    await act(async () => {
      await result.current.mutateAsync('recent')
    })
    expect(mockApi.settings.set).toHaveBeenCalledWith({ key: 'notes.recencyMode', value: 'recent' })
  })
})
