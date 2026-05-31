import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
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
      // React Compiler (babel-plugin-react-compiler 1.0) auto-memoizes
      // components and stabilizes callbacks at build time, so the rolling
      // feed reconciles only the bubbles that actually changed during a
      // scroll instead of every visible one each frame. This is the classic-
      // Babel form valid for @vitejs/plugin-react v5; v6 (Vite 8, oxc) would
      // instead need @rolldown/plugin-babel. No `target` or runtime package
      // is needed on React 19 — `react/compiler-runtime` ships with React.
      // @see adrs/0006-react-compiler.md
      // @see https://react.dev/learn/react-compiler/installation
      react({ babel: { plugins: ['babel-plugin-react-compiler'] } }),
    ],
    server: {
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
