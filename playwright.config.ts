/**
 * Playwright-test config for the visual-regression harness (v0.8.1, #191).
 *
 * This config governs ONLY `tests/visual/**` — the `toHaveScreenshot()` shots.
 * It does not touch Vitest (which owns unit/component/integration) and it does
 * not touch the bare-`playwright` `.mjs` smokes under `scripts/`, which stay on
 * `node scripts/*.mjs` and are unaffected by anything here.
 *
 * Vitest does not collect these specs: `vitest.config.ts:11-38` gives both
 * projects explicit `include` arrays keyed on a `.test.` infix under
 * `src/**` / `tests/integration/**`. `tests/visual/*.spec.ts` matches neither
 * the directory nor the infix, so no exclusion is needed.
 *
 * Run: `pnpm test:visual` (builds, aligns the native ABI, runs under Xvfb).
 * Re-baseline: `pnpm test:visual:update`.
 *
 * @see docs/specs/v0.8.1-housekeeping.md §4.2
 * @see adrs/0060-playwright-test-visual-regression.md
 * @issue utof/linsae#191
 */
import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: 'tests/visual',

  /**
   * `{platform}` is the load-bearing token (spec §4.3.3 / §1 non-goals): text
   * rasterises differently per OS, so a macOS or Windows run must not compare
   * against Linux bytes. With the platform in the path such a run finds NO
   * baseline and writes its own instead of failing on font hinting. Only
   * `linux` baselines are committed.
   */
  snapshotPathTemplate: '{testDir}/__screenshots__/{platform}/{testFileName}/{arg}{ext}',

  /**
   * Electron launches are not parallel-safe here: each spec drives a real app
   * process with its own `--user-data-dir`, and concurrent windows on one Xvfb
   * display contend for focus and compositing. Serial is also what makes the
   * shots comparable — a backgrounded window can render differently.
   */
  fullyParallel: false,
  workers: 1,

  /**
   * Deliberately zero. A retry turns a flaky shot green and hides exactly the
   * failure mode this harness must never develop (spec §4.3: a screenshot test
   * that is not deterministic is worse than none). If a spec needs a retry to
   * pass, that is a bug in the spec, not a scheduling problem.
   */
  retries: 0,

  /** Electron boot + reconcile + first paint runs ~10-20s on a cold cache. */
  timeout: 120_000,

  reporter: [['list']],

  expect: {
    timeout: 20_000,
    toHaveScreenshot: {
      /**
       * `threshold` is the per-pixel YIQ colour distance below which two pixels
       * count as equal (Playwright's default, restated so it is visible next to
       * the ratio it pairs with). `maxDiffPixelRatio` is the fraction of the
       * frame allowed to differ at all.
       *
       * BOTH numbers are measured, not guessed. Spec §4.3.3 assumed font
       * rendering would force a loose ratio; on this harness it does not, and
       * the tight number is the better one:
       *
       *   noise floor — a full run at `maxDiffPixelRatio: 0` (pixel-exact)
       *                 passed all four shots against baselines an EARLIER run
       *                 had written. One comparison per shot, not a
       *                 distribution — enough to show nothing moves
       *                 systematically, not enough to rule out rare jitter.
       *   signal      — perturbing `--fg-0` to `#FFFFFF` (the §4.5 acceptance
       *                 demonstration) moved 7,203 px on the thread shot and
       *                 17,091 / 17,145 / 18,527 px on feed / pdf / canvas.
       *
       * 0.0005 (512 px at 1280x800) sits above a floor of zero and 14x below
       * the smallest observed regression. A ratio in the 0.5% range that the
       * spec suggested would have left the thread shot only 1.4x of margin.
       *
       * Note what this tolerance does NOT buy: it is jitter insurance, not
       * portability. A host with a different font package differs by far more
       * than 512 px, and the answer there is a re-baseline under `{platform}`,
       * not a looser ratio.
       */
      threshold: 0.2,
      maxDiffPixelRatio: 0.0005,
      /**
       * Belt-and-braces only. Per Playwright's `docs/src/api/params.md` this
       * stops "CSS animations, CSS transitions, and Web Animations" — broader
       * than CSS alone, so it does cover WAAPI — but NOT the rAF/`MotionValue`
       * work that is most of this app's motion (ADR 0019). The primary
       * mechanism is `prefers-reduced-motion: reduce`, forced in
       * `tests/visual/harness.ts`, which short-circuits those paths at the
       * source instead of fighting them from outside.
       */
      animations: 'disabled',
      /** CSS pixels, so a host with a non-1 device scale factor still matches. */
      scale: 'css',
    },
  },
})
