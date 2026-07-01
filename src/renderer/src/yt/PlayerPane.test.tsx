// @vitest-environment happy-dom
/**
 * Component tests for PlayerPane — the right-dock content pane that hosts the
 * singleton YouTube webview placeholder (B5 single-mount invariant).
 *
 * Assertions:
 *   (a) PlayerPane renders player-host when videoId is set via 'player.videoId' setting.
 *   (b) PlayerPane renders no player-host when videoId is null (loading / no video).
 *   (c) player.load() is called with the videoId from the setting (usePlayer is in PlayerPane).
 *   (d) Opening a youtube ThreadView opens the 'player' pane in dockStore (right side).
 *   (e) ThreadView's youtube branch no longer renders an in-body player-host element.
 *
 * Note: the real gate for (a)-(c) is a Playwright-Electron smoke test (singleton
 * mount / cookie cannot be verified in happy-dom). The mock assertions are the
 * closest available automated check.
 *
 * ISOLATION NOTE: vitest.config.ts sets `isolate: false` for the dom pool —
 * test files share the module cache. Do NOT mock './usePlayer' here; doing so
 * would leak into usePlayer.test.tsx and break those tests. Instead mock
 * './playerSingleton' completely so the real usePlayer runs against the mock
 * singleton. (ADR 0014 follow-up)
 *
 * @see src/renderer/src/yt/PlayerPane.tsx
 * @see src/renderer/src/yt/usePlayer.ts
 * @see src/renderer/src/panes/dockStore.ts
 */

import { screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installMockApi, renderWithProviders } from '../../../../tests/setup'
import type { Note } from '../../../shared/types'
import { useDockStore } from '../panes/dockStore'

// ISOLATION: isolate:false shares the module cache across files. Reset modules
// here (via vi.hoisted, which runs before any imports) so THIS file loads a
// fresh usePlayer.ts against THIS file's playerSingleton mock. usePlayer.test.tsx
// does the same — each file gets its own module closure with its own spies. (ADR 0014)
vi.hoisted(() => vi.resetModules())

// ── mock playerSingleton completely so real usePlayer can run against it ──────
// mount/load are spies so tests can assert PlayerPane hands the mount to usePlayer.
// Do NOT mock usePlayer itself — see isolation note above.
const mount = vi.fn()
const unmount = vi.fn()
const load = vi.fn().mockResolvedValue(undefined)
const onStateChange = vi.fn(() => () => {})
const getCurrentTime = vi.fn(async () => 0)
const getDuration = vi.fn(async () => null)
const getMediaRect = vi.fn<() => DOMRect | null>(() => null)

vi.mock('./playerSingleton', () => ({
  getPlayer: () => ({
    mount,
    unmount,
    load,
    onStateChange,
    getCurrentTime,
    getDuration,
    play: vi.fn(),
    pause: vi.fn(),
    seekTo: vi.fn().mockResolvedValue(undefined),
    setPlaybackRate: vi.fn(),
    toggleFullscreen: vi.fn(),
    getMediaRect,
    videoId: null,
    wrapper: document.createElement('div'),
  }),
  destroyPlayer: vi.fn(),
  setPlayerInteractive: vi.fn(),
  isYoutubeChromeShown: vi.fn(() => false),
}))

// ── mock usePlayerState used by ThreadView (avoids rAF polling in tests) ──────
// This is a ThreadView dependency — must be mocked so ThreadView renders cleanly
// in the integration tests (d) and (e) below.
vi.mock('./usePlayerState', () => ({
  usePlayerState: () => ({
    player: {
      seekTo: vi.fn(),
      play: vi.fn(),
      pause: vi.fn(),
    },
    currentTime: 0,
    state: 'paused' as const,
    duration: 100,
  }),
}))

// Import components AFTER vi.mock so hoisted mocks apply.
import { ThreadView } from '../thread/ThreadView'
import { PlayerPane } from './PlayerPane'

// ── fixtures ──────────────────────────────────────────────────────────────────

const YOUTUBE_NOTE: Note = {
  id: 'yt-1',
  slug: 'my-video',
  body: '',
  type: 'source',
  created_at: 1000,
  updated_at: 1000,
  deleted_at: null,
  source_kind: 'youtube',
  source_locator: { media: 'youtube', video_id: 'dQw4w9WgXcQ' },
}

// ── test setup ────────────────────────────────────────────────────────────────

beforeEach(() => {
  useDockStore.getState().reset()
  mount.mockClear()
  unmount.mockClear()
  load.mockClear()
  onStateChange.mockClear()
  getCurrentTime.mockClear()
  getDuration.mockClear()
  getMediaRect.mockClear()

  const mockApi = installMockApi()
  mockApi.notes.get.mockResolvedValue(YOUTUBE_NOTE)
  mockApi.videoSources.get.mockResolvedValue({
    title: 'Rick Astley',
    channel: 'RickAstleyVEVO',
    thumbnailUrl: null,
    durationSec: 213,
  })
  mockApi.videoSources.upsert.mockResolvedValue(undefined)
  mockApi.links.commentsOf.mockResolvedValue([])
  // Default: player.videoId not yet set (null).
  // api.settings.get receives { key } (api.ts positional-arg wrapper).
  mockApi.settings.get.mockImplementation(async () => ({ value: null }))
  mockApi.settings.set.mockResolvedValue({ ok: true as const })
})

afterEach(() => vi.restoreAllMocks())

// ── PlayerPane unit tests ─────────────────────────────────────────────────────

describe('PlayerPane', () => {
  it('(a) renders player-host when videoId is available via the setting', async () => {
    // Override settings.get so useSetting('player.videoId') resolves to 'dQw4w9WgXcQ'.
    // api.settings.get receives { key } (api.ts positional-arg wrapper) → destructure.
    const mockApi = installMockApi()
    mockApi.settings.get.mockImplementation(async ({ key }: { key: string }) =>
      key === 'player.videoId' ? { value: 'dQw4w9WgXcQ' } : { value: null },
    )

    renderWithProviders(<PlayerPane />)

    await waitFor(() => expect(screen.getByTestId('player-host')).toBeInTheDocument())
  })

  it('(b) renders no player-host when videoId is null (setting not yet set)', async () => {
    // Default mock returns { value: null } → useSetting falls back to null → inner component absent.
    renderWithProviders(<PlayerPane />)
    // Give any async query time to settle (should still be null).
    await new Promise((r) => setTimeout(r, 50))
    expect(screen.queryByTestId('player-host')).toBeNull()
    expect(screen.getByTestId('player-pane')).toBeInTheDocument()
  })

  it('(c) player.load() is called with the videoId (real usePlayer in PlayerPaneInner)', async () => {
    // When videoId is non-null, PlayerPaneInner mounts and usePlayer calls player.load(videoId).
    // This verifies that the mount+load lives in PlayerPane, not ThreadView (B5 invariant).
    const mockApi = installMockApi()
    mockApi.settings.get.mockImplementation(async ({ key }: { key: string }) =>
      key === 'player.videoId' ? { value: 'dQw4w9WgXcQ' } : { value: null },
    )

    renderWithProviders(<PlayerPane />)

    await waitFor(() => expect(load).toHaveBeenCalledWith('dQw4w9WgXcQ'))
  })
})

// ── ThreadView + dock integration ─────────────────────────────────────────────

describe('ThreadView: player pane dock integration', () => {
  it('(d) opening a youtube thread activates the player pane in the right dock', async () => {
    renderWithProviders(<ThreadView noteId="yt-1" onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText('Rick Astley')).toBeInTheDocument())

    // The player pane should be opened in the right dock by ThreadView's effect.
    await waitFor(() => expect(useDockStore.getState().right.activeId).toBe('player'))
  })

  it('(e) ThreadView youtube branch does NOT render an in-body player-host element', async () => {
    renderWithProviders(<ThreadView noteId="yt-1" onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText('Rick Astley')).toBeInTheDocument())

    // After the B5 lift, the player-host placeholder lives in PlayerPane (right dock),
    // NOT inside the ThreadView body. The ThreadView test tree has no Dock, so
    // player-host is entirely absent from the rendered output.
    expect(screen.queryByTestId('player-host')).toBeNull()
  })
})
