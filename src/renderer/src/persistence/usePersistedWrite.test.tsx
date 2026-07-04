// @vitest-environment happy-dom
/**
 * Component-level test for `usePersistedWrite`.
 *
 * The hook talks to `api` (the lib wrapper) directly — no react-query — so
 * `installMockApi()` alone suffices and no QueryClientProvider wrapper is needed
 * (the plan's `wrapper: Providers` is dropped per its own harness note).
 *
 * Assertion form: `mock.settings.set` IS `window.api.settings.set`, and the `api`
 * wrapper packs positional args into `{ key, value }` — so the mock records the
 * object form, matching the repo convention (use-setting.test.tsx:66,
 * SettingsPanel.test.tsx:83), not the plan's positional shorthand.
 *
 * @see src/renderer/src/persistence/usePersistedWrite.ts
 * @see docs/specs/v0.7-session-persistence.md §Write-through
 */
import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { installMockApi } from '../../../../tests/setup'
import { usePersistedWrite } from './usePersistedWrite'

describe('usePersistedWrite', () => {
  it('coalesces rapid changes into one trailing write; flushes on hidden', async () => {
    const mock = installMockApi()
    vi.useFakeTimers()
    const { rerender } = renderHook(
      ({ v }) => usePersistedWrite('k', v, { debounceMs: 300, enabled: true }),
      { initialProps: { v: 'a' } },
    )
    rerender({ v: 'b' })
    rerender({ v: 'c' })
    vi.advanceTimersByTime(300)
    expect(mock.settings.set).toHaveBeenCalledTimes(1)
    expect(mock.settings.set).toHaveBeenLastCalledWith({ key: 'k', value: 'c' })
    // visibilitychange flush writes immediately
    rerender({ v: 'd' })
    Object.defineProperty(document, 'hidden', { value: true, configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
    expect(mock.settings.set).toHaveBeenLastCalledWith({ key: 'k', value: 'd' })
    vi.useRealTimers()
  })

  it('does not echo the hydrated value: skips the first *enabled* render (boot path)', () => {
    const mock = installMockApi()
    vi.useFakeTimers()
    const { rerender } = renderHook(
      ({ v, on }) => usePersistedWrite('k', v, { debounceMs: 300, enabled: on }),
      { initialProps: { v: 'default', on: false } },
    )
    // boot: hydration completes → enabled flips true AND value becomes the persisted value
    rerender({ v: 'hydrated', on: true })
    vi.advanceTimersByTime(300)
    expect(mock.settings.set).not.toHaveBeenCalled() // hydrated value must NOT be written back
    // a genuine post-boot edit persists exactly once
    rerender({ v: 'edited', on: true })
    vi.advanceTimersByTime(300)
    expect(mock.settings.set).toHaveBeenCalledTimes(1)
    expect(mock.settings.set).toHaveBeenLastCalledWith({ key: 'k', value: 'edited' })
    vi.useRealTimers()
  })
})
