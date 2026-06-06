import { resolve } from 'node:path'
import babel from '@rolldown/plugin-babel'
import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import { DEV_MEDIA_PORT } from './src/main/http-shell'

export default defineConfig({
  main: {
    plugins: [
      // Externalizes native modules (better-sqlite3) and node_modules from the
      // main process bundle. Without this, electron-vite tries to bundle the
      // native .node binding and fails at runtime.
      // @see https://electron-vite.org/guide/getting-started#project-structure
      externalizeDepsPlugin(),
    ],
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve(__dirname, 'src/renderer/src'),
        // @shared alias mirrors the tsconfig.web.json paths entry added in Task 12.
        // Why: shared types/utils are used by both renderer and tests; a path alias
        // avoids long relative ../../shared imports.
        '@shared': resolve(__dirname, 'src/shared'),
      },
    },
    plugins: [
      react(),
      // React Compiler (babel-plugin-react-compiler 1.0) auto-memoizes
      // components and stabilizes callbacks at build time, so the rolling feed
      // reconciles only the bubbles that changed during a scroll. On
      // @vitejs/plugin-react v6 (Vite 8 / oxc) the classic-Babel pipeline
      // (react({ babel: { plugins: [...] } })) is gone, so the compiler runs via
      // @rolldown/plugin-babel + reactCompilerPreset. The `await` works around
      // electron-vite's deepClone choking on the babel factory's Promise<Plugin>
      // (electron-vite#902). No runtime package needed on React 19 —
      // `react/compiler-runtime` ships with React.
      // @see adrs/0006-react-compiler.md
      // @see https://github.com/alex8088/electron-vite/issues/902
      await babel({ presets: [reactCompilerPreset()] }),
    ],
    server: {
      // Warm up the first-paint module graph at dev-server start so the
      // renderer's first request doesn't waterfall through ~50 source files
      // (each paying the Babel react-compiler pass) on a cold `pnpm dev`. This
      // overlaps the transform with main-process boot + Electron window startup.
      // Paths are relative to the renderer root (`src/renderer`, set by
      // electron-vite). Only OUR source is listed — node_modules deps are
      // already pre-bundled (node_modules/.vite/deps shows `discovered: none`),
      // so `optimizeDeps.include` would be redundant. Measured: cold first paint
      // ~4.2s vs warm ~1.2s, so the cold source-transform is the target here.
      // @see https://vite.dev/guide/performance#warm-up-frequently-used-files
      warmup: {
        clientFiles: [
          './src/main.tsx',
          './src/App.tsx',
          './src/feed/Feed.tsx',
          './src/feed/NoteBubble.tsx',
          './src/lib/markdown.tsx',
          './src/composer/Composer.tsx',
        ],
      },
      // Proxy /_media/ to the loopback shell's fixed dev port so attachment
      // images are same-origin (relative /_media/<tail>) in the dev renderer.
      // In prod the loopback shell serves both the renderer bundle and /_media/
      // on the same http://127.0.0.1:<port>; the proxy makes dev match prod.
      // @see src/main/http-shell.ts (DEV_MEDIA_PORT, startLoopbackShell)
      // @see docs/specs/v0.2-localhost-shell.md §7 B1
      proxy: {
        '/_media': { target: `http://127.0.0.1:${DEV_MEDIA_PORT}` },
      },
    },
  },
})
