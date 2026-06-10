/**
 * Facade unit tests for api.youtube / api.attachments / api.videoSources
 * and the extended api.notes.create / api.notes.update (source fields).
 *
 * Why: verifies that the ergonomic positional-arg wrappers forward the correct
 * single-object payload to window.api.* as required by the preload contract.
 *
 * @see src/renderer/src/lib/api.ts
 * @see src/preload/index.ts (window.api surface)
 */
import { describe, expect, it, vi } from 'vitest'
import { api } from './api'

/** Shared stub that satisfies all window.api namespaces used in this file. */
function makeWindowApi(overrides: Record<string, unknown> = {}): void {
  // @ts-expect-error test stub
  window.api = {
    youtube: {
      capture: vi.fn(),
      fetchOEmbed: vi.fn(),
      authStatus: vi.fn(),
      signIn: vi.fn(),
      signOut: vi.fn(),
      importCookies: vi.fn(),
      saveOverlay: vi.fn(),
    },
    attachments: { list: vi.fn(), attachToNote: vi.fn(), remove: vi.fn() },
    videoSources: { upsert: vi.fn(), get: vi.fn() },
    notes: { list: vi.fn(), get: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    ...overrides,
  }
}

describe('api.youtube/attachments/videoSources facade', () => {
  it('capture forwards positional args as the channel payload', async () => {
    const capture = vi.fn().mockResolvedValue({
      id: 'a1',
      path: '/x.png',
      sha256: 's',
      width: 2,
      height: 1,
      devicePixelRatio: 2,
    })
    makeWindowApi({
      youtube: {
        capture,
        fetchOEmbed: vi.fn(),
        authStatus: vi.fn(),
        signIn: vi.fn(),
        signOut: vi.fn(),
        importCookies: vi.fn(),
        saveOverlay: vi.fn(),
      },
    })
    const r = await api.youtube.capture({ x: 0, y: 0, width: 200, height: 120 }, 'vid', 83)
    expect(capture).toHaveBeenCalledWith({
      rect: { x: 0, y: 0, width: 200, height: 120 },
      videoId: 'vid',
      t: 83,
    })
    expect(r.id).toBe('a1')
  })

  it('videoSources.upsert spreads optional oEmbed metadata', async () => {
    const upsert = vi.fn().mockResolvedValue(undefined)
    makeWindowApi({ videoSources: { upsert, get: vi.fn() } })
    await api.videoSources.upsert('vid', { title: 'T', channel: 'C' })
    expect(upsert).toHaveBeenCalledWith({
      videoId: 'vid',
      sourceKind: 'youtube',
      title: 'T',
      channel: 'C',
    })
  })

  it('notes.create forwards source_kind/source_locator/commentOn when given', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'n1' })
    makeWindowApi({
      notes: { list: vi.fn(), get: vi.fn(), create, update: vi.fn(), delete: vi.fn() },
    })
    await api.notes.create('body', 'claim', {
      source_kind: 'youtube',
      source_locator: { media: 'youtube', video_id: 'v', t: 5 },
      commentOn: 'video-slug',
    })
    expect(create).toHaveBeenCalledWith({
      body: 'body',
      type: 'claim',
      source_kind: 'youtube',
      source_locator: { media: 'youtube', video_id: 'v', t: 5 },
      commentOn: 'video-slug',
    })
  })

  it('youtube.saveOverlay forwards attachmentId + svg as the channel payload', async () => {
    const saveOverlay = vi.fn().mockResolvedValue({ overlayPath: '/data/2024/06/att-1.svg' })
    makeWindowApi({
      youtube: {
        capture: vi.fn(),
        fetchOEmbed: vi.fn(),
        authStatus: vi.fn(),
        signIn: vi.fn(),
        signOut: vi.fn(),
        importCookies: vi.fn(),
        saveOverlay,
      },
    })
    const r = await api.youtube.saveOverlay(
      'att-1',
      '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
    )
    expect(saveOverlay).toHaveBeenCalledWith({
      attachmentId: 'att-1',
      svg: '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
    })
    expect(r.overlayPath).toBe('/data/2024/06/att-1.svg')
  })

  it('youtube.saveOverlay forwards svg: null for clear', async () => {
    const saveOverlay = vi.fn().mockResolvedValue({ overlayPath: null })
    makeWindowApi({
      youtube: {
        capture: vi.fn(),
        fetchOEmbed: vi.fn(),
        authStatus: vi.fn(),
        signIn: vi.fn(),
        signOut: vi.fn(),
        importCookies: vi.fn(),
        saveOverlay,
      },
    })
    const r = await api.youtube.saveOverlay('att-1', null)
    expect(saveOverlay).toHaveBeenCalledWith({ attachmentId: 'att-1', svg: null })
    expect(r.overlayPath).toBeNull()
  })

  it('attachments.remove forwards the id as the channel payload', async () => {
    const remove = vi.fn().mockResolvedValue(undefined)
    makeWindowApi({ attachments: { list: vi.fn(), attachToNote: vi.fn(), remove } })
    await api.attachments.remove('att-2')
    expect(remove).toHaveBeenCalledWith({ id: 'att-2' })
  })
})
