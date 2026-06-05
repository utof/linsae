/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * When set (`VITE_PLAYGROUND=1 electron-vite build`), includes the dev-only reveal
   * playground in a build so it can be harness-driven. Unset in normal builds, so it
   * tree-shakes out. @see src/renderer/src/App.tsx (DEV_PLAYGROUND)
   */
  readonly VITE_PLAYGROUND?: string
}

interface Window {
  /**
   * Dev-only morph slow-motion multiplier. Set in DevTools (e.g.
   * `window.__morphSlow = 8`) to watch the expand/collapse easing play out
   * frame-by-frame while tuning its feel. Read only under `import.meta.env.DEV`
   * (tree-shaken out of production). See GH #49.
   */
  __morphSlow?: number
}
