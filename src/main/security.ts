/**
 * Hardened defaults for every {@link Electron.BrowserWindow} the main process
 * creates.
 *
 * Why: Electron's default `BrowserWindow` is permissive (node integration on,
 * sandbox off). Centralising the secure-baseline flags here means every window
 * goes through the same chokepoint — defence in depth against a renderer
 * compromise reaching the host filesystem or Node APIs.
 *
 * @see https://www.electronjs.org/docs/latest/tutorial/security
 * @see docs/specs/v0.1-rolling-feed-and-search.md §Electron security baseline
 */

import type { WebPreferences } from 'electron'

/**
 * Returns the hardened `webPreferences` block for the renderer window.
 *
 * - `contextIsolation: true` — preload script runs in an isolated context so
 *   the renderer cannot reach into the preload's scope or Node globals.
 * - `nodeIntegration: false` — renderer has no `require()` / `process` /
 *   `Buffer`; all main-process access flows through the preload contextBridge.
 * - `sandbox: true` — renderer runs inside Chromium's OS-level sandbox.
 * - `preload` — absolute path to the bundled preload script; only it can call
 *   `contextBridge.exposeInMainWorld`.
 *
 * Why this exact combination (defence in depth): each flag mitigates a
 * distinct failure mode (script injection, dependency RCE, kernel exploit).
 * Removing any one of them defeats the others.
 *
 * Why the return type is the bare `WebPreferences` (not
 * `BrowserWindowConstructorOptions['webPreferences']`, which includes
 * `undefined`): `tsconfig.node.json` enables `exactOptionalPropertyTypes`, so
 * a `T | undefined` value cannot be assigned to a non-optional `T` property
 * on the constructor options object.
 *
 * @param preloadPath - Absolute filesystem path to the compiled preload
 *   script. The caller resolves it relative to the main bundle's `__dirname`.
 * @returns A `webPreferences` object ready to pass to `new BrowserWindow(...)`.
 * @see docs/specs/v0.1-rolling-feed-and-search.md §Electron security baseline
 */
export function secureWebPreferences(preloadPath: string): WebPreferences {
  return {
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    preload: preloadPath,
  }
}
