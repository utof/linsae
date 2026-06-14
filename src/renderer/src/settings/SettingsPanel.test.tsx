/**
 * Component tests for SettingsPanel — feed entrance animation picker.
 *
 * Renders the full SettingsPanel (open=true) via renderWithProviders + installMockApi.
 * The YoutubeAccountSection calls api.youtube.authStatus on mount, so we provide
 * that and other auth methods via the overrides argument to installMockApi.
 *
 * @see src/renderer/src/settings/SettingsPanel.tsx
 * @see src/renderer/src/lib/anim-pref.ts
 */

import { fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installMockApi, type MockApi, renderWithProviders } from '../../../../tests/setup'
import { getFeedEntrance } from '../lib/anim-pref'

let mockApi: MockApi

beforeEach(() => {
  mockApi = installMockApi({
    youtube: {
      capture: vi.fn(async () => ({
        id: '',
        path: '',
        sha256: '',
        width: 0,
        height: 0,
        devicePixelRatio: 1,
      })),
      fetchOEmbed: vi.fn(async () => null),
      // Extra youtube auth methods needed by YoutubeAccountSection (not in MockApi type)
      authStatus: vi.fn(async () => ({ signedIn: false })),
      signIn: vi.fn(async () => ({ ok: true })),
      signOut: vi.fn(async () => ({ ok: true })),
      importCookies: vi.fn(async () => ({ canceled: true })),
    } as ReturnType<typeof installMockApi>['youtube'] & {
      authStatus: ReturnType<typeof vi.fn>
      signIn: ReturnType<typeof vi.fn>
      signOut: ReturnType<typeof vi.fn>
      importCookies: ReturnType<typeof vi.fn>
    },
  })
})

afterEach(() => {
  localStorage.clear()
})

// ── SettingsPanel must be imported after mocks are hoisted ──────────────────
import { SettingsPanel } from './SettingsPanel'

describe('SettingsPanel — feed entrance animation picker', () => {
  it('changing the select to "flip" persists via setFeedEntrance', () => {
    renderWithProviders(<SettingsPanel open onClose={() => {}} />)

    const select = screen.getByRole('combobox', { name: /feed entrance animation/i })
    expect(select).toBeInTheDocument()
    // value is bound to the pref (useFeedEntrance) — defaults to glide before any change.
    expect(select).toHaveValue('glide')

    fireEvent.change(select, { target: { value: 'flip' } })

    expect(getFeedEntrance()).toBe('flip')
    // The bound select re-renders to the new pref (reactive value binding, not a hardcoded
    // value): guards against value={entrance} being dropped or hardcoded.
    expect(select).toHaveValue('flip')
  })
})

describe('SettingsPanel — SearchSection recency-mode toggle', () => {
  it('defaults to frecent (absence-default) and changing it calls settings.set', async () => {
    renderWithProviders(<SettingsPanel open onClose={() => {}} />)

    const select = await screen.findByRole('combobox', { name: /recent-notes order/i })
    // useSetting returns the absence-default 'frecent' (mock settings.get → { value: null }).
    await waitFor(() => expect(select).toHaveValue('frecent'))

    fireEvent.change(select, { target: { value: 'recent' } })

    // useSetSetting.mutate → api.settings.set('notes.recencyMode', 'recent')
    // → window.api.settings.set({ key, value }).
    await waitFor(() => {
      expect(mockApi.settings.set).toHaveBeenCalledWith({
        key: 'notes.recencyMode',
        value: 'recent',
      })
    })
  })
})
