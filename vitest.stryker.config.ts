import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

/**
 * Vitest config used ONLY by Stryker (`stryker.conf.json` → `vitest.configFile`).
 *
 * Why a second config rather than the main one: Stryker's dry run executes the WHOLE suite to
 * collect per-test coverage, and it aborts the entire mutation run if a single test fails
 * ("There were failed tests in the initial test run"). Measured on this repo — the first stage-0
 * attempt died there, not on any mutant. With #203 open (DOM-heavy files fail ~8 `waitFor`
 * assertions under CPU contention, on trees that cannot reach them), pointing Stryker at the full
 * suite means the run is decided by a coin flip before mutation testing even starts.
 *
 * So the dry run is scoped to the files actually being mutated. Two consequences worth knowing:
 *
 *   - The `node` project is dropped entirely, so no `better-sqlite3` ABI rebuild is needed.
 *   - Widening `mutate` in `stryker.conf.json` WITHOUT widening `include` here means the new
 *     files get no covering tests and every mutant reports as `NoCoverage`. Widen both together.
 *
 * A whole-repo mutation run stays blocked on #203 by construction. That is the honest state of
 * things, and it is the argument for fixing the flake first.
 *
 * @see .github/workflows/mutation.yml
 * @issue utof/linsae#203
 */
export default defineConfig({
  test: {
    globals: false,
    passWithNoTests: true,
    name: 'stryker',
    environment: 'happy-dom',
    setupFiles: ['./tests/setup.tsx'],
    // Mirrors the main config's `dom` project. Stryker's runner overrides pool/maxWorkers
    // itself (threads, 1), so nothing here needs to say so.
    isolate: false,
    include: ['src/renderer/src/yt/**/*.test.{ts,tsx}'],
  },
  resolve: {
    alias: {
      '@renderer': fileURLToPath(new URL('./src/renderer/src', import.meta.url)),
      '@shared': fileURLToPath(new URL('./src/shared', import.meta.url)),
    },
  },
})
