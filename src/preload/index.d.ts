/**
 * Global type augmentation: `window.api` is the contextBridge-exposed surface
 * defined in `./index.ts`. Imported by the renderer's tsconfig.web.json so
 * every renderer file sees a fully-typed `window.api`.
 *
 * @see src/preload/index.ts
 * @see tsconfig.web.json (includes this file)
 */

import type { LinsaeApi } from './index'

declare global {
  interface Window {
    api: LinsaeApi
  }
}
