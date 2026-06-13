/**
 * Harness control bridge (spec §3 / §17). The Playwright-Electron perf harness
 * cannot drive the canvas through gestures deterministically nor reach the
 * dev-only LOD store, so — and ONLY when launched with LINSAE_HARNESS=1 (the
 * preload then sets `window.api.isHarness`) — CanvasStage attaches this bridge
 * to `window.__canvasHarness`. The runner uses `setCamera` to drive a known
 * camera path (measuring RENDER cost of a fixed path, spike-faithful — the same
 * thing scripts/spike-canvas gated) and `setDevLod` to force the dot tier.
 *
 * Inert in normal prod use: `installHarnessBridge` is never called unless
 * `window.api.isHarness` is true, so the global stays undefined.
 * @see docs/specs/v0.4-canvas-mvp.md §3 §17
 * @see scripts/canvas-perf-harness.mjs
 */
import type { Camera } from './camera'
import type { CanvasDevLod } from './dev-lod'

/** The methods the perf harness drives the canvas through. */
export interface CanvasHarnessBridge {
  /** Set the camera to an exact {x,y,zoom} (the runner's choreography step). */
  setCamera: (camera: Camera) => void
  /** Read the live camera (so the runner can anchor a steady oscillation). */
  getCamera: () => Camera
  /** Toggle dev-LOD (force dot tier + synthetic 10k dots + unclamp zoom). */
  setDevLod: (patch: Partial<CanvasDevLod>) => void
}

declare global {
  interface Window {
    /** Present ONLY under LINSAE_HARNESS=1; see CanvasHarnessBridge. */
    __canvasHarness?: CanvasHarnessBridge
  }
}

/** Attach the bridge so the harness can find it. Idempotent (last wins). */
export function installHarnessBridge(bridge: CanvasHarnessBridge): void {
  window.__canvasHarness = bridge
}

/**
 * Detach the bridge (CanvasStage unmount / test cleanup). Uses `delete` rather
 * than `= undefined` because tsconfig has `exactOptionalPropertyTypes: true`,
 * under which assigning `undefined` to an optional property is a type error;
 * reading the removed property still yields `undefined` (the install/uninstall
 * test asserts `toBeUndefined()`).
 */
export function uninstallHarnessBridge(): void {
  delete window.__canvasHarness
}
