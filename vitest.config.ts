import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'jsdom',
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
      // Only @renderer is mirrored in electron.vite.config.ts + tsconfig.web.json paths today.
      // Add @main / @shared here AND in those configs when a test or src file actually uses them.
      '@renderer': fileURLToPath(new URL('./src/renderer/src', import.meta.url)),
    },
  },
})
