import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: false,
    passWithNoTests: true,
    // Two projects so pure-logic tests skip the DOM env AND the RTL/jest-dom setup
    // file. Measured: node-env files were paying ~4.3s each loading setup.tsx for
    // nothing (~95s aggregate). happy-dom over jsdom — see ADR 0014.
    projects: [
      {
        extends: true,
        test: {
          name: 'node',
          environment: 'node',
          include: [
            'src/main/**/*.test.{ts,tsx}',
            'src/shared/**/*.test.{ts,tsx}',
            'tests/integration/**/*.test.{ts,tsx}',
          ],
        },
      },
      {
        extends: true,
        test: {
          name: 'dom',
          environment: 'happy-dom',
          setupFiles: ['./tests/setup.tsx'],
          // isolate:false reuses one happy-dom context per worker instead of
          // tearing it down per file (34s→17s for this project). Safe here: RTL
          // auto-cleanup() resets the DOM per test, and component tests use
          // renderWithProviders' fresh QueryClient (not the module singleton).
          // node project keeps isolation (real SQLite). See ADR 0014 follow-up.
          isolate: false,
          include: ['src/renderer/**/*.test.{ts,tsx}'],
        },
      },
    ],
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
