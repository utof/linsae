/**
 * Harness control bridge (spec §3 / §17): the Playwright perf harness reaches
 * the canvas camera + dev-LOD ONLY through `window.__canvasHarness`, attached
 * by CanvasStage when `window.api.isHarness` is true. Pure install/uninstall +
 * the typed global — kept out of CanvasStage's body so it is unit-testable and
 * the `window` augmentation lives in one place.
 * @see docs/specs/v0.4-canvas-mvp.md §3 §17
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  type CanvasHarnessBridge,
  installHarnessBridge,
  uninstallHarnessBridge,
} from './harness-bridge'

const makeBridge = (): CanvasHarnessBridge => ({
  setCamera: vi.fn(),
  getCamera: vi.fn(() => ({ x: 0, y: 0, zoom: 1 })),
  setDevLod: vi.fn(),
})

afterEach(() => {
  uninstallHarnessBridge()
})

describe('harness-bridge', () => {
  it('attaches the bridge to window.__canvasHarness on install', () => {
    const b = makeBridge()
    installHarnessBridge(b)
    expect(window.__canvasHarness).toBe(b)
  })

  it('removes the bridge on uninstall', () => {
    installHarnessBridge(makeBridge())
    uninstallHarnessBridge()
    expect(window.__canvasHarness).toBeUndefined()
  })

  it('routes setCamera / getCamera / setDevLod to the installed bridge', () => {
    const b = makeBridge()
    installHarnessBridge(b)
    window.__canvasHarness?.setCamera({ x: 10, y: 20, zoom: 1.5 })
    window.__canvasHarness?.getCamera()
    window.__canvasHarness?.setDevLod({ forceTier: 'dot' })
    expect(b.setCamera).toHaveBeenCalledWith({ x: 10, y: 20, zoom: 1.5 })
    expect(b.getCamera).toHaveBeenCalledOnce()
    expect(b.setDevLod).toHaveBeenCalledWith({ forceTier: 'dot' })
  })
})
