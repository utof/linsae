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
 *   (f)-(n) B2: the TransportBar is mounted in the docked player and every control is
 *       live — including the rate RE-PUSH that survives a guest reload (#169).
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

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installMockApi, renderWithProviders } from '../../../../tests/setup'
import type { PlayerState } from '../../../shared/player'
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
const getCurrentTime = vi.fn(async () => 0)
const getDuration = vi.fn<() => Promise<number | null>>(async () => null)
const getMediaRect = vi.fn<() => DOMRect | null>(() => null)
// B2: the five TransportBar callbacks land on these. Module-level (not inline in the
// factory) because `getPlayer: () => ({…})` builds a NEW object per call — inline spies
// would be unreachable from the tests.
const play = vi.fn().mockResolvedValue(undefined)
const pause = vi.fn().mockResolvedValue(undefined)
const seekTo = vi.fn().mockResolvedValue(undefined)
const setPlaybackRate = vi.fn().mockResolvedValue(undefined)
const toggleFullscreen = vi.fn()
// Captured `onStateChange` subscriber, so a test can drive a guest state event —
// the only public signal that a freshly-loaded guest's RPC port is live.
let stateCb: ((s: PlayerState) => void) | null = null
const onStateChange = vi.fn((cb: (s: PlayerState) => void) => {
  stateCb = cb
  return () => {
    stateCb = null
  }
})

vi.mock('./playerSingleton', () => ({
  getPlayer: () => ({
    mount,
    unmount,
    load,
    onStateChange,
    getCurrentTime,
    getDuration,
    play,
    pause,
    seekTo,
    setPlaybackRate,
    toggleFullscreen,
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
import { useTransportStore } from './transportState'

/**
 * The transport store's own initial state, captured at module load before any test
 * mutates it — same technique (and same reason) as transportState.test.ts:18.
 *
 * MANDATORY here, and note which direction the danger runs: the `dom` project sets
 * `isolate: false` (vitest.config.ts:35), so this module singleton is shared with every
 * other file in the worker, and `vi.resetModules()` at :42 does NOT give this file a
 * private copy of it. `beforeEach` protects THIS file from whatever ran before it; the
 * `afterEach` protects the NEXT file from this one. Without the latter the last test's
 * mutations escape, and the next file's own module-load capture records them as its
 * "initial" — which is how transportState.test.ts:36-38 (`INITIAL.rate === 1`) goes red
 * for a reason having nothing to do with the store. (#203)
 */
const TRANSPORT_INITIAL = useTransportStore.getState()

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
  // `setState(…, true)` REPLACES rather than merges, so no mutated field survives.
  useTransportStore.setState(TRANSPORT_INITIAL, true)
  mount.mockClear()
  unmount.mockClear()
  load.mockClear()
  onStateChange.mockClear()
  getCurrentTime.mockClear()
  getDuration.mockClear()
  getDuration.mockResolvedValue(null)
  getMediaRect.mockClear()
  play.mockClear()
  pause.mockClear()
  seekTo.mockClear()
  setPlaybackRate.mockClear()
  toggleFullscreen.mockClear()
  stateCb = null

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

afterEach(() => {
  vi.restoreAllMocks()
  // Hand the store back pristine so the NEXT file in this worker captures a clean
  // module-load snapshot. Today this file happens to end on the dock-integration block,
  // whose tests leave the store clean anyway — reordering the describes, appending a
  // test, sharding, or running with `-t` removes that accident. Do not rely on it.
  useTransportStore.setState(TRANSPORT_INITIAL, true)
})

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

// ── B2: TransportBar in the docked player (#169) ──────────────────────────────

/** Point `useSetting('player.videoId')` at `id` (fresh window.api mock). */
function mockVideoIdSetting(id: string | null): void {
  const mockApi = installMockApi()
  mockApi.settings.get.mockImplementation(async ({ key }: { key: string }) =>
    key === 'player.videoId' ? { value: id } : { value: null },
  )
  mockApi.settings.set.mockResolvedValue({ ok: true as const })
}

/**
 * Render in a CALLER-OWNED QueryClient (renderWithProviders hides its client), so the
 * video-change test can invalidate `['setting','player.videoId']` and drive PlayerPane
 * from one videoId to another the way the real app does.
 */
function renderPane() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const result = render(
    <QueryClientProvider client={qc}>
      <PlayerPane />
    </QueryClientProvider>,
  )
  return { ...result, qc }
}

async function renderPaneWithVideo(id = 'dQw4w9WgXcQ') {
  mockVideoIdSetting(id)
  const r = renderPane()
  await waitFor(() => expect(screen.getByTestId('player-host')).toBeInTheDocument())
  return r
}

describe('PlayerPane transport bar (B2, #169)', () => {
  it('(f) renders every transport control beside the docked player', async () => {
    await renderPaneWithVideo()

    // Native YouTube controls are suppressed in the guest (youtube-guest.ts:121,
    // `v.controls = false`), so these ARE the player's only control surface.
    expect(screen.getByLabelText('play')).toBeInTheDocument()
    expect(screen.getByTestId('scrubber-track')).toBeInTheDocument()
    expect(screen.getByLabelText('playback speed')).toBeInTheDocument()
    expect(screen.getByLabelText('fullscreen')).toBeInTheDocument()
    expect(screen.getByLabelText('follow playback')).toBeInTheDocument()
    // The host placeholder must still be present and never display:none'd
    // (electron#7700) — the bar shares a flex column with it, it does not replace it.
    expect(screen.getByTestId('player-host')).toBeInTheDocument()
  })

  it('(g) renders NO transport bar while videoId is null (guard branch is untouched)', async () => {
    mockVideoIdSetting(null)
    renderPane()
    await waitFor(() => expect(screen.getByTestId('player-pane')).toBeInTheDocument())
    expect(screen.queryByLabelText('play')).toBeNull()
    expect(screen.queryByTestId('scrubber-track')).toBeNull()
  })

  it('(h) play/pause drives the singleton, following the reported player state', async () => {
    await renderPaneWithVideo()

    fireEvent.click(screen.getByLabelText('play'))
    expect(play).toHaveBeenCalledTimes(1)

    // Guest reports playback started → the button becomes Pause.
    expect(stateCb).not.toBeNull()
    act(() => stateCb?.('playing'))
    fireEvent.click(screen.getByLabelText('pause'))
    expect(pause).toHaveBeenCalledTimes(1)
  })

  it('(i) the speed badge cycles the SHARED store rate and pushes it to the player', async () => {
    await renderPaneWithVideo()

    fireEvent.click(screen.getByLabelText('playback speed'))
    expect(useTransportStore.getState().rate).toBe(1.25)
    expect(setPlaybackRate).toHaveBeenLastCalledWith(1.25)
    expect(screen.getByLabelText('playback speed')).toHaveTextContent('1.25×')

    fireEvent.click(screen.getByLabelText('playback speed'))
    expect(useTransportStore.getState().rate).toBe(1.5)
    expect(setPlaybackRate).toHaveBeenLastCalledWith(1.5)
  })

  it('(j) the follow toggle flips the shared store flag (ThreadView reads the same one)', async () => {
    await renderPaneWithVideo()

    const btn = screen.getByLabelText('follow playback')
    expect(btn).toHaveAttribute('data-active', 'true')

    fireEvent.click(btn)
    expect(useTransportStore.getState().followOn).toBe(false)
    expect(screen.getByLabelText('follow playback')).toHaveAttribute('data-active', 'false')
  })

  it('(k) the fullscreen button asks the guest for its own fullscreen', async () => {
    await renderPaneWithVideo()
    fireEvent.click(screen.getByLabelText('fullscreen'))
    expect(toggleFullscreen).toHaveBeenCalledTimes(1)
  })

  it('(l) scrubber ticks come from the store markers and seek to their own t', async () => {
    // Ticks only render once duration is known (TransportBar.tsx:164, safeD > 0).
    getDuration.mockResolvedValue(213)
    await renderPaneWithVideo()

    act(() => useTransportStore.getState().setMarkers([12, 40.5]))
    await waitFor(() => expect(screen.getAllByTestId('scrubber-marker')).toHaveLength(2))

    fireEvent.click(screen.getAllByTestId('scrubber-marker')[0] as Element)
    expect(seekTo).toHaveBeenCalledWith(12)
  })

  it('(m) RE-PUSHES the rate when the video changes (load() reloads the guest, wiping it)', async () => {
    // load(id) reassigns webviewEl.src (playerSingleton.ts:299-307) — a full guest
    // reload that destroys the <video> the guest's setRate wrote to
    // (youtube-guest.ts:203). The store is the sole holder of `rate` and Player has no
    // getPlaybackRate(), so without this the badge reads 1.25× while playback runs 1×.
    mockVideoIdSetting('vid-A')
    const { qc } = renderPane()
    await waitFor(() => expect(load).toHaveBeenCalledWith('vid-A'))

    fireEvent.click(screen.getByLabelText('playback speed'))
    expect(setPlaybackRate).toHaveBeenLastCalledWith(1.25)
    setPlaybackRate.mockClear()

    mockVideoIdSetting('vid-B')
    await act(async () => {
      await qc.invalidateQueries({ queryKey: ['setting', 'player.videoId'] })
    })

    await waitFor(() => expect(load).toHaveBeenCalledWith('vid-B'))
    expect(setPlaybackRate).toHaveBeenCalledWith(1.25)
  })

  it('(n) RE-PUSHES the rate on a guest state event (the port is null right after load)', async () => {
    // setPlaybackRate is `rpc?.invoke('setRate', r)` (playerSingleton.ts:337-339) and
    // load() nulls `rpc` (:303) until the reloaded guest's dom-ready re-creates it, so a
    // push fired at videoId-change time is swallowed. A state event is the only public
    // signal that the new guest's port is live — hence it is also a re-push trigger.
    await renderPaneWithVideo()
    fireEvent.click(screen.getByLabelText('playback speed'))
    setPlaybackRate.mockClear()

    expect(stateCb).not.toBeNull()
    act(() => stateCb?.('playing'))
    expect(setPlaybackRate).toHaveBeenCalledWith(1.25)
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
