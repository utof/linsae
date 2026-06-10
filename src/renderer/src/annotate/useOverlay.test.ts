// @vitest-environment happy-dom
/**
 * Tests for useOverlay: useOverlayScene (read hook) and saveOverlay (write helper).
 *
 * Uses renderWithProviders + installMockApi + a global fetch mock.
 *
 * @see src/renderer/src/annotate/useOverlay.ts
 * @see docs/specs/v0.2.5-screenshot-annotation.md §useOverlay
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installMockApi } from '../../../../tests/setup'
import type { Attachment } from '../../../shared/types'
import { serializeScene } from '../ink/svg'
import type { Scene } from '../ink/types'
import { saveOverlay, useOverlayScene } from './useOverlay'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BASE_ATTACHMENT: Attachment = {
  id: 'att-001',
  note_id: 'note-001',
  kind: 'screenshot',
  base_sha256: 'abcdef',
  base_path: '/store/2026/05/abcdef.png',
  overlay_path: null,
  video_id: 'vid1',
  time_seconds: 42,
  width_px: 1920,
  height_px: 1080,
  device_pixel_ratio: 2,
  created_at: 1000,
  deleted_at: null,
}

// A real scene with one stroke — exercises the full serialize→fetch→parse path.
const SCENE_WITH_ELEMENTS: Scene = {
  width: 1920,
  height: 1080,
  elements: [
    {
      id: 'stroke-1',
      kind: 'stroke',
      points: [
        { x: 10, y: 20, pressure: 0.5 },
        { x: 30, y: 40, pressure: 0.6 },
        { x: 50, y: 60, pressure: 0.7 },
        { x: 70, y: 80, pressure: 0.8 },
      ],
      color: '#0D99FF',
      size: 8,
      simulatePressure: false,
    },
  ],
}

// Wrapper providing a fresh QueryClient per test
function makeWrapper(): {
  wrapper: ({ children }: { children: ReactNode }) => ReactNode
  qc: QueryClient
} {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: qc }, children)
  return { wrapper, qc }
}

// ---------------------------------------------------------------------------
// Tests: useOverlayScene
// ---------------------------------------------------------------------------

describe('useOverlayScene', () => {
  beforeEach(() => {
    installMockApi()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns { scene: null } immediately when overlay_path is null (no fetch)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const attachment = { ...BASE_ATTACHMENT, overlay_path: null }
    const { wrapper } = makeWrapper()

    const { result } = renderHook(() => useOverlayScene(attachment), { wrapper })

    await waitFor(() => {
      expect(result.current.scene).toBeNull()
    })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('fetches mediaUrlFromPath(overlay_path) with { cache: "no-store" } and returns parsed scene', async () => {
    const svgText = serializeScene(SCENE_WITH_ELEMENTS)
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(svgText, { status: 200 }))

    const attachment = {
      ...BASE_ATTACHMENT,
      overlay_path: '/store/2026/05/att-001.svg',
    }
    const { wrapper } = makeWrapper()

    const { result } = renderHook(() => useOverlayScene(attachment), { wrapper })

    await waitFor(() => {
      expect(result.current.scene).not.toBeNull()
    })

    // Must fetch the media URL
    expect(fetchSpy).toHaveBeenCalledOnce()
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit | undefined]
    expect(url).toBe('/_media/2026/05/att-001.svg')
    // CRITICAL: must use cache: 'no-store' to avoid stale overlays
    expect(init).toMatchObject({ cache: 'no-store' })

    // Scene dimensions come from the parsed SVG
    expect(result.current.scene?.width).toBe(1920)
    expect(result.current.scene?.height).toBe(1080)
  })

  it('returns { scene: null } on a 404 response without throwing (settled value)', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('Not Found', { status: 404 }))
    const attachment = {
      ...BASE_ATTACHMENT,
      overlay_path: '/store/2026/05/att-001.svg',
    }
    const { wrapper, qc } = makeWrapper()
    const key = ['overlay', 'att-001', '/store/2026/05/att-001.svg']

    const { result } = renderHook(() => useOverlayScene(attachment), { wrapper })

    // Wait for the query to SETTLE (success), not just for a transient null.
    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalled()
      expect(qc.getQueryState(key)?.status).toBe('success')
    })
    // The settled scene must be null (404 → no overlay).
    expect(result.current.scene).toBeNull()
  })

  it('returns { scene: null } on an unparseable body without throwing (settled value)', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('this is not svg at all !!', { status: 200 }))
    const attachment = {
      ...BASE_ATTACHMENT,
      overlay_path: '/store/2026/05/att-001.svg',
    }
    const { wrapper, qc } = makeWrapper()
    const key = ['overlay', 'att-001', '/store/2026/05/att-001.svg']

    const { result } = renderHook(() => useOverlayScene(attachment), { wrapper })

    // Wait for the query to SETTLE (success). parseScene returns the garbage
    // sentinel {0,0,[]} which the hook maps to null — assert the SETTLED value,
    // not a transient loading-state null.
    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalled()
      expect(qc.getQueryState(key)?.status).toBe('success')
    })
    expect(result.current.scene).toBeNull()
  })

  it('uses query key [overlay, attachment.id, attachment.overlay_path]', async () => {
    const svgText = serializeScene(SCENE_WITH_ELEMENTS)
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(svgText, { status: 200 }))

    const attachment = {
      ...BASE_ATTACHMENT,
      overlay_path: '/store/2026/05/att-001.svg',
    }
    const { wrapper, qc } = makeWrapper()

    const { result } = renderHook(() => useOverlayScene(attachment), { wrapper })
    await waitFor(() => expect(result.current.scene).not.toBeNull())

    // The cache entry for the correct key must exist
    const cached = qc.getQueryData(['overlay', 'att-001', '/store/2026/05/att-001.svg'])
    expect(cached).not.toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Tests: saveOverlay
// ---------------------------------------------------------------------------

describe('saveOverlay', () => {
  let mockApi: ReturnType<typeof installMockApi>

  beforeEach(() => {
    mockApi = installMockApi()
  })

  it('calls api.youtube.saveOverlay with serialized scene and invalidates [overlay, id]', async () => {
    const svgText = serializeScene(SCENE_WITH_ELEMENTS)
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(svgText, { status: 200 }))

    const { qc } = makeWrapper()

    const attachment = {
      ...BASE_ATTACHMENT,
      overlay_path: '/store/2026/05/att-001.svg',
    }

    // Preload some data in the cache to verify invalidation clears it
    qc.setQueryData(['overlay', 'att-001', '/store/2026/05/att-001.svg'], SCENE_WITH_ELEMENTS)

    mockApi.youtube.saveOverlay.mockResolvedValue({ overlayPath: '/store/2026/05/att-001.svg' })

    // saveOverlay is a standalone function; pass the qc directly
    await saveOverlay(qc, attachment, SCENE_WITH_ELEMENTS)

    // api.youtube.saveOverlay is window.api.youtube.saveOverlay (object arg from facade)
    expect(mockApi.youtube.saveOverlay).toHaveBeenCalledOnce()
    const [callArg] = mockApi.youtube.saveOverlay.mock.calls[0] as [
      { attachmentId: string; svg: string | null },
    ]
    expect(callArg.attachmentId).toBe('att-001')
    expect(typeof callArg.svg).toBe('string')
    expect((callArg.svg as string).startsWith('<svg')).toBe(true)

    // After invalidateQueries the query is marked stale (not deleted — React Query v5
    // keeps the data in cache but marks it invalid so it refetches on next mount).
    const queryState = qc.getQueryState(['overlay', 'att-001', '/store/2026/05/att-001.svg'])
    expect(queryState?.isInvalidated).toBe(true)
  })

  it('passes svg: null when scene is null (clear overlay)', async () => {
    mockApi.youtube.saveOverlay.mockResolvedValue({ overlayPath: null })
    const { qc } = makeWrapper()

    await saveOverlay(qc, BASE_ATTACHMENT, null)

    expect(mockApi.youtube.saveOverlay).toHaveBeenCalledOnce()
    const [callArg] = mockApi.youtube.saveOverlay.mock.calls[0] as [
      { attachmentId: string; svg: string | null },
    ]
    expect(callArg.svg).toBeNull()
  })
})
