/// <reference types="vite/client" />

interface Window {
  /**
   * Dev-only morph slow-motion multiplier. Set in DevTools (e.g.
   * `window.__morphSlow = 8`) to watch the expand/collapse easing play out
   * frame-by-frame while tuning its feel. Read only under `import.meta.env.DEV`
   * (tree-shaken out of production). See GH #49.
   */
  __morphSlow?: number
}
