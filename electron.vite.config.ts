import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

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
    plugins: [react()],
  },
})
