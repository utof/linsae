/**
 * Deterministic launch + seed harness for the visual-regression specs.
 *
 * This module is the reusable core of the v0.8.1 harness (spec §4.3): every
 * `tests/visual/*.spec.ts` gets its window, its vault, and its determinism
 * guarantees from here, so a new shot costs a `launchSeeded()` call plus an
 * assertion.
 *
 * Determinism is fought on five fronts, because a screenshot test that is not
 * deterministic is worse than none — it trains you to ignore red:
 *
 *  1. SEED DATA — the vault is written to disk BEFORE the app launches, with
 *     fixed ids, fixed slugs and fixed `created_at`. The startup reconciler
 *     (src/main/db/reconcile.ts) treats disk as the source of truth and imports
 *     them verbatim, so the feed's `ORDER BY created_at DESC, rowid DESC`
 *     (src/main/db/queries/notes.ts:135) resolves identically on every run.
 *     Seeding through `window.api.notes.create` would NOT do this: main stamps
 *     `Date.now()` server-side (src/main/save-note.ts) and mints a time-ordered
 *     uuidv7, so bodies would be fixed but timestamps never would.
 *  2. ANIMATION — `prefers-reduced-motion: reduce` is forced, which the app
 *     honours at the SOURCE (App.tsx:1169 `useReducedMotion()`,
 *     feed/entrance/waveReveal.ts:187, glideReveal.ts:134,
 *     useExpandCollapseMorph.ts:112, src/renderer/index.html:57) rather than
 *     being fought from outside. Belt-and-braces: `animations: 'disabled'` in
 *     playwright.config.ts, which stops CSS animations/transitions AND Web
 *     Animations but NOT the rAF/MotionValue work that is most of this app —
 *     hence reduced-motion leading. {@link assertDeterministicEnv} fails loudly
 *     if the media query did not actually take.
 *  3. LOCALE + TIMEZONE — `locale: 'en-US'` + `timezoneId: 'UTC'` pin
 *     `toLocaleTimeString` / `toLocaleDateString`, which render on every note
 *     bubble (lib/wallclock.ts) and every day divider (lib/day.ts).
 *  4. RENDERED CLOCKS — {@link timeMasks} masks the wall-clock labels anyway.
 *     Spec §4.3.4 prefers masking over pinning a fake clock because a mask is
 *     local and cannot be defeated by a later timezone or locale change.
 *  5. VIEWPORT — the Electron window's CONTENT size is pinned from the main
 *     process. `_electron.launch()` has no `viewport` option (verified against
 *     playwright-core's `Electron.launch` type: acceptDownloads, args,
 *     artifactsDir, bypassCSP, chromiumSandbox, colorScheme, cwd, env,
 *     executablePath, extraHTTPHeaders, geolocation, httpCredentials,
 *     ignoreHTTPSErrors, locale, offline, recordHar, recordVideo, timezoneId,
 *     tracesDir — and nothing else), because an Electron window's size belongs
 *     to `BrowserWindow`, not to a browser context.
 *
 * Fonts are the one source we do not solve: text rasterises differently across
 * machines. That is why `snapshotPathTemplate` carries `{platform}` and why the
 * thresholds are non-zero rather than pixel-exact (spec §4.3.3).
 *
 * @see docs/specs/v0.8.1-housekeeping.md §4
 * @see adrs/0060-playwright-test-visual-regression.md
 * @see scripts/pdf-render-smoke.mjs (the launch/teardown discipline mirrored here)
 * @issue utof/linsae#191
 *
 * Note the single import source: `_electron` comes from `@playwright/test`, not
 * from `playwright`. `playwright/types/test.d.ts:19` is `export * from
 * 'playwright-core'`, which carries `export const _electron: Electron`
 * (playwright-core/types/types.d.ts:17254). Importing it from the bare
 * `playwright` package instead would give this file two Playwright packages to
 * disagree about — the skew ADR 0060 exists to prevent.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type ElectronApplication,
  _electron as electron,
  expect,
  type Locator,
  type Page,
} from '@playwright/test'

/**
 * `process.cwd()`, not `import.meta.url` and not `__dirname`.
 *
 * The repo's package.json has no `"type": "module"`, so Playwright's TypeScript
 * loader transpiles these specs to CommonJS, where `import.meta` is a syntax
 * error ("Cannot use 'import.meta' outside a module") — the `.mjs` smokes under
 * `scripts/` can use it only because their extension opts them into ESM.
 * `__dirname` would work today but would break the day the package flips to
 * `"type": "module"`. `process.cwd()` works under both, and Playwright only
 * discovers `playwright.config.ts` when invoked from the repo root anyway, so
 * cwd is pinned by the same fact that makes the run possible.
 */
const REPO_ROOT = process.cwd()

/** The electron-vite bundle the harness launches — NOT the packaged app (spec §9.3). */
const MAIN_ENTRY = join(REPO_ROOT, 'out', 'main', 'index.js')

/** 1-page fixture reused from the PDF smokes; small and stable. */
export const TINY_PDF = join(REPO_ROOT, 'tests', 'fixtures', 'tiny.pdf')

/**
 * Fixed content size for every shot. Matches `createWindow`'s default
 * (src/main/index.ts:96-97) so the shots look like the real app, and comfortably
 * clears its `minWidth: 720` / `minHeight: 400` floor and the 1440x900 virtual
 * screen that `pnpm test:visual` starts (see package.json).
 */
const VIEWPORT = { width: 1280, height: 800 } as const

/**
 * Seed timestamps live in **2024**, deliberately more than two days before any
 * plausible run date, so `formatDayLabel` (lib/day.ts:43) takes its
 * locale-date branch and appends the year — `"May 17, 2024"`, a string that is
 * stable forever. Timestamps inside the last two days would render the
 * relative `"today"` / `"yesterday"` labels, which flip as the clock rolls.
 */
const SEED_DAY = Date.UTC(2024, 4, 17)

/** One minute, in ms — the spacing between seeded notes. */
const MINUTE = 60_000

/**
 * A note as written into the throwaway vault. Mirrors `NoteFrontmatter`
 * (src/main/files/frontmatter.ts:14) minus the fields the harness never needs.
 */
export interface SeedNote {
  id: string
  slug: string
  type: 'claim' | 'question' | 'source'
  createdAt: number
  body: string
}

/**
 * The shared deterministic vault. Ids are fixed uuidv7-SHAPED strings, not
 * generated ones: the app treats a note id as an opaque `z.string().min(1)`
 * (src/shared/zod-schemas.ts), and a fixed id keeps the `<id>.md` filename — and
 * therefore `readdirSync` order, and therefore `rowid` tie-breaks — identical
 * across runs.
 *
 * Bodies are chosen to exercise the token surface the harness exists to guard:
 * a heading, body prose, emphasis, inline code, a bullet list, a wikilink, and
 * a `?`-promoted question note. The original motivation is
 * `docs/specs/v0.1-rolling-feed-and-search.md:368` — *"the user specifically
 * called out the 'AI writes black-on-black' failure mode"*.
 */
export const SEED_NOTES: readonly SeedNote[] = [
  {
    id: '0190a000-0000-7000-8000-000000000001',
    slug: 'visual-regression-baseline',
    type: 'claim',
    createdAt: SEED_DAY + 9 * 60 * MINUTE,
    body: '# Visual regression baseline\n\nThis vault is fixed. Every id, slug and timestamp in it is a constant, so the feed renders the same pixels on every run.',
  },
  {
    id: '0190a000-0000-7000-8000-000000000002',
    slug: 'tokens-are-the-contract',
    type: 'claim',
    createdAt: SEED_DAY + 10 * 60 * MINUTE,
    body: 'Tokens are the contract. Body text is `var(--fg-1)`, metadata is `var(--fg-2)`, and the bubble sits on `var(--bg-1)`.\n\n- a bullet, to exercise list spacing\n- **bold** and *italic* runs\n- a link to [[visual-regression-baseline]]',
  },
  {
    id: '0190a000-0000-7000-8000-000000000003',
    slug: 'what-breaks-silently',
    type: 'question',
    createdAt: SEED_DAY + 11 * 60 * MINUTE,
    body: 'What breaks silently when a color token drifts?',
  },
  {
    id: '0190a000-0000-7000-8000-000000000004',
    slug: 'the-answer-is-contrast',
    type: 'claim',
    createdAt: SEED_DAY + 12 * 60 * MINUTE,
    body: 'Contrast. A layout regression is loud — the page moves. A contrast regression is silent: the text is still there, still selectable, still in the accessibility tree, and completely unreadable.',
  },
  {
    id: '0190a000-0000-7000-8000-000000000005',
    slug: 'a-longer-note-for-wrapping',
    type: 'claim',
    createdAt: SEED_DAY + 13 * 60 * MINUTE,
    body: 'A longer note, so at least one bubble wraps across several lines and the harness covers multi-line leading as well as single-line bubbles. Wrapping is where a line-height token regression shows up first, and it is invisible in a one-line sample.',
  },
  {
    id: '0190a000-0000-7000-8000-000000000006',
    slug: 'shortest-note',
    type: 'claim',
    createdAt: SEED_DAY + 14 * 60 * MINUTE,
    body: 'Short.',
  },
] as const

/**
 * The note whose thread the thread shot opens. Its two children are created
 * through IPC rather than seeded on disk, because a `comment-on` edge is
 * DB-only: `replaceLinksForNote` writes `edge_type='reference'` edges derived
 * from the body and explicitly leaves `comment-on` alone
 * (src/main/db/queries/links.ts:37-48), so a vault file cannot express one.
 * Their wall-clock labels are therefore live — which is exactly what
 * {@link timeMasks} covers.
 */
export const THREAD_ROOT = SEED_NOTES[1] as SeedNote

/**
 * Serialises one seed note into the on-disk note format,
 * `---\n<yaml>\n---\n\n<body>` (src/main/files/frontmatter.ts:88).
 *
 * Why hand-rolled rather than importing `serializeFrontmatter`: that module is
 * main-process code, and `tests/**` is compiled by `tsconfig.web.json`. The
 * seed values are plain ASCII scalars with no YAML metacharacters, so quoting
 * is unnecessary — and if this ever drifts from the real format the reconciler
 * skips the file, the seeded text never appears, and
 * {@link assertSeedRendered} fails the run rather than silently baselining an
 * empty feed.
 */
function serializeSeedNote(n: SeedNote): string {
  const fm = [
    `id: ${n.id}`,
    `slug: ${n.slug}`,
    `type: ${n.type}`,
    `created_at: ${n.createdAt}`,
    `updated_at: ${n.createdAt}`,
  ].join('\n')
  return `---\n${fm}\n---\n\n${n.body}`
}

/**
 * Writes the deterministic vault into `<userDataDir>/notes`, the directory the
 * main process reconciles at startup (src/main/index.ts:159-173).
 *
 * Why before launch and not after: the reconciler runs once, during boot,
 * inside a single transaction. Files written afterwards are invisible until the
 * next launch.
 */
function writeVault(userDataDir: string, notes: readonly SeedNote[]): void {
  const notesDir = join(userDataDir, 'notes')
  mkdirSync(notesDir, { recursive: true })
  for (const n of notes) {
    writeFileSync(join(notesDir, `${n.id}.md`), serializeSeedNote(n), 'utf8')
  }
}

/** What {@link launchSeeded} hands back; `dispose` is the `finally` teardown. */
export interface SeededApp {
  app: ElectronApplication
  page: Page
  userDataDir: string
  dispose: () => Promise<void>
}

/**
 * Launches the built app against a throwaway, freshly-seeded profile.
 *
 * Mirrors the launch/teardown discipline of `scripts/pdf-render-smoke.mjs`: a
 * `mkdtempSync` `--user-data-dir` so a run never touches the real vault, and an
 * unconditional teardown. Callers must `await dispose()` in a `finally`.
 *
 * @param notes - Vault contents. Defaults to {@link SEED_NOTES}; pass a subset
 *   to keep a surface's shot focused.
 */
export async function launchSeeded(notes: readonly SeedNote[] = SEED_NOTES): Promise<SeededApp> {
  if (!existsSync(MAIN_ENTRY)) {
    throw new Error(
      `${MAIN_ENTRY} is missing — the visual harness launches the BUILT app. Run \`pnpm exec electron-vite build\` first (\`pnpm test:visual\` does this for you).`,
    )
  }

  const userDataDir = mkdtempSync(join(tmpdir(), 'linsae-visual-'))
  writeVault(userDataDir, notes)

  const app = await electron.launch({
    args: [
      MAIN_ENTRY,
      `--user-data-dir=${userDataDir}`,
      // Chromium's own reduced-motion switch, so the preference is in force from
      // the very first paint (the boot splash's shimmer honours it too —
      // src/renderer/index.html:57). `page.emulateMedia` below is the
      // authoritative belt-and-braces; this is the braces.
      '--force-prefers-reduced-motion',
    ],
    // Pins every `toLocaleTimeString` / `toLocaleDateString` the renderer makes.
    locale: 'en-US',
    timezoneId: 'UTC',
    colorScheme: 'light',
  })

  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')

  await page.emulateMedia({ reducedMotion: 'reduce' })
  await pinViewport(app, page)
  await assertDeterministicEnv(page)

  return {
    app,
    page,
    userDataDir,
    dispose: async () => {
      await app.close()
      rmSync(userDataDir, { recursive: true, force: true })
    },
  }
}

/**
 * Pins the renderer's viewport by setting the BrowserWindow's CONTENT size from
 * the main process, then waits for the renderer to observe it.
 *
 * Why not `page.setViewportSize`: an Electron window is not a browser context —
 * its size is owned by `BrowserWindow`, and `_electron.launch()` exposes no
 * `viewport` option at all.
 */
async function pinViewport(app: ElectronApplication, page: Page): Promise<void> {
  await app.evaluate(async ({ BrowserWindow }, size) => {
    const win = BrowserWindow.getAllWindows()[0]
    if (!win) throw new Error('no BrowserWindow to size')
    win.setContentSize(size.width, size.height)
  }, VIEWPORT)
  await page.waitForFunction(
    (size) => window.innerWidth === size.width && window.innerHeight === size.height,
    VIEWPORT,
    { timeout: 10_000 },
  )
}

/**
 * Fails the run if the determinism guarantees did not actually take.
 *
 * Why assert rather than trust: a silently-ineffective `reducedMotion` would not
 * fail anything — it would just make the baselines flaky later, which is the
 * one outcome this harness exists to avoid. Same for the locale/timezone pins:
 * if they are ignored the shots still render, just with the wrong clock.
 */
async function assertDeterministicEnv(page: Page): Promise<void> {
  const env = await page.evaluate(() => ({
    reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    locale: Intl.DateTimeFormat().resolvedOptions().locale,
  }))
  expect(env.reducedMotion, 'prefers-reduced-motion must be forced').toBe(true)
  expect(env.timeZone, 'timezone must be pinned to UTC').toBe('UTC')
  expect(env.locale, 'locale must be pinned to en-US').toBe('en-US')
}

/**
 * Turns a markdown source string into a substring that will actually appear in
 * the rendered DOM.
 *
 * Bodies here are rendered through react-markdown, so every markdown
 * metacharacter is consumed by the parser: `` `var(--fg-1)` `` becomes a
 * `<code>` element whose text has no backticks, and `**bold**` becomes
 * `<strong>bold</strong>`. A naive `body.slice(0, n)` probe that happens to
 * straddle one of those characters can never match, and — worse — it fails as a
 * *missing element*, which reads exactly like "the app did not render", sending
 * you to debug the wrong thing. Cutting the probe at the first metacharacter
 * keeps it inside a single rendered text node.
 */
function renderedProbe(body: string, max = 40): string {
  const firstLine = (body.split('\n')[0] ?? '').replace(/^#+\s*/, '')
  const cut = firstLine.search(/[`*_[\]]/)
  return (cut === -1 ? firstLine : firstLine.slice(0, cut)).trim().slice(0, max)
}

/**
 * Waits until every seeded body is on screen.
 *
 * Load-bearing, not decorative: the reconciler SKIPS a malformed file instead of
 * throwing (reconcile.ts §malformed-skip), so a drifted seed format would boot
 * an app with an empty feed and `toHaveScreenshot` would happily baseline the
 * emptiness. This turns that into a failure.
 */
export async function assertSeedRendered(page: Page, notes: readonly SeedNote[]): Promise<void> {
  for (const n of notes) {
    await assertBodyRendered(page, n.body)
  }
}

/**
 * Waits for one markdown body to be on screen, matched by {@link renderedProbe}.
 * Exported for content the specs create themselves (the thread's IPC-created
 * children), which never round-trips through {@link SEED_NOTES}.
 */
export async function assertBodyRendered(page: Page, body: string): Promise<void> {
  const probe = renderedProbe(body)
  await expect(
    page.getByText(probe, { exact: false }).first(),
    `expected the rendered DOM to contain ${JSON.stringify(probe)}`,
  ).toBeVisible({ timeout: 20_000 })
}

/**
 * Locators for every rendered wall-clock label, for `toHaveScreenshot`'s `mask`.
 *
 * The pattern matches exactly what `formatTimeOnly` emits
 * (lib/wallclock.ts:12 — `{ hour: 'numeric', minute: '2-digit' }`), anchored so
 * it can only match a leaf whose entire text is a clock. `\s` rather than a
 * literal space because modern ICU separates the time from AM/PM with U+202F
 * (narrow no-break space), not U+0020.
 *
 * Seeded notes have fixed timestamps and would not need this; the thread's
 * IPC-created children do (see {@link THREAD_ROOT}). Applying it uniformly
 * keeps one rule for all shots instead of a per-surface exception, and costs
 * four ~40x12px rectangles.
 */
export function timeMasks(page: Page): Locator[] {
  return [page.getByText(/^\d{1,2}:\d{2}\s?(AM|PM)$/)]
}
