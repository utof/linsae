// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

function stubWebview(el: HTMLElement) {
  const ex = vi.fn(async (_code: string, _gesture?: boolean) => undefined)
  Object.assign(el, {
    executeJavaScript: ex,
    insertCSS: vi.fn(async () => 'key'),
    setUserAgent: vi.fn(),
  })
  el.getBoundingClientRect = () =>
    ({
      x: 1,
      y: 2,
      width: 320,
      height: 180,
      top: 2,
      left: 1,
      right: 321,
      bottom: 182,
      toJSON() {},
    }) as DOMRect
}

beforeEach(() => {
  const orig = document.createElement.bind(document)
  vi.spyOn(document, 'createElement').mockImplementation(((
    tag: string,
    opts?: ElementCreationOptions,
  ) => {
    const el = orig(tag, opts)
    if (tag === 'webview') stubWebview(el)
    return el
  }) as typeof document.createElement)
})

import { destroyPlayer, getPlayer } from './playerSingleton'

afterEach(() => {
  destroyPlayer()
  vi.restoreAllMocks()
})

describe('playerSingleton (webview)', () => {
  it('constructs the wrapper+webview exactly once', () => {
    const a = getPlayer()
    expect(getPlayer()).toBe(a)
    expect(a.wrapper.querySelectorAll('webview').length).toBe(1)
  })
  it('load sets the canonical watch src', async () => {
    const p = getPlayer()
    await p.load('M7lc1UVf-VE')
    const wv = p.wrapper.querySelector('webview') as unknown as { src: string }
    expect(wv.src).toBe('https://www.youtube.com/watch?v=M7lc1UVf-VE')
    expect(p.videoId).toBe('M7lc1UVf-VE')
  })
  it('play() grants a user gesture via executeJavaScript(code, true)', async () => {
    const p = getPlayer()
    const wv = p.wrapper.querySelector('webview') as unknown as {
      executeJavaScript: ReturnType<typeof vi.fn>
    }
    await p.play()
    expect(wv.executeJavaScript).toHaveBeenCalledWith(expect.any(String), true)
  })
  it('getCurrentTime resolves from the cache with no RPC handshake', async () => {
    const p = getPlayer()
    expect(await p.getCurrentTime()).toBe(0)
  })
  it('getMediaRect returns the webview rect', () => {
    expect(getPlayer().getMediaRect()?.width).toBe(320)
  })
  it('reconstructs after destroyPlayer()', () => {
    const a = getPlayer()
    destroyPlayer()
    expect(getPlayer()).not.toBe(a)
  })
})
