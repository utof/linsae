import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // happy-dom over jsdom: jsdom's environment construction measured ~4s per
    // component file and dominated the suite (~100s → ~70s on the switch). DB and
    // integration tests pin `// @vitest-environment node` per-file. See ADR 0014.
    environment: 'happy-dom',
    globals: false,
    passWithNoTests: true,
    setupFiles: ['./tests/setup.tsx'],
    include: ['src/**/*.test.{ts,tsx}', 'tests/**/*.test.{ts,tsx}'],
    coverage: {
      reporter: ['text', 'html'],
      // vitest v4: coverage.all removed; include drives both covered + uncovered files.
      // See: https://github.com/vitest-dev/vitest/blob/main/docs/guide/migration.md
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.test.{ts,tsx}', 'src/renderer/src/main.tsx'],
    },
  },
  resolve: {
    alias: {
      '@renderer': fileURLToPath(new URL('./src/renderer/src', import.meta.url)),
      // @shared mirrors electron.vite.config.ts + tsconfig.web.json paths.
      // Added Task 12: needed so renderer+test imports resolve without long relative paths.
      '@shared': fileURLToPath(new URL('./src/shared', import.meta.url)),
    },
  },
})
