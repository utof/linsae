/**
 * Playwright-Electron smoke for the v0.3 webview player (Task T7), extended at v0.8.2
 * with the DOCKED TRANSPORT gates (Task B4).
 * Tests the webview engine against live YouTube — the FIRST real-world test of
 * the webview-backed player (see adrs/0016-webview-youtube-player.md).
 *
 * Split into two gates:
 *   CI-safe  (always)   — webview presence, CLEAN_CSS opacity, rect, capturePage PNG,
 *                         and the four transport gates that need only layout.
 *   Live     (opt-in)   — everything that needs a real <video> in the guest: play/pause,
 *                         scrubber click→seek, marker tick geometry, rate across a guest
 *                         reload. Set SMOKE_PLAYBACK=1 to enable.
 *
 * WHY THE TRANSPORT IS GATED HERE AND NOT IN VITEST (#169). v0.6.4's B5 lifted the player
 * into the right-dock `PlayerPane` and dropped `ThreadView`'s `TransportBar`; YouTube's own
 * controls are suppressed in the guest (`attachVideo`'s `v.controls = false`, in
 * `yt/inject/youtube-guest.ts`), so for two milestones the docked player had no scrubber,
 * speed badge, follow toggle or fullscreen at all. v0.8.2 B1–B3 put them back. **Unit tests cannot show that
 * they work**, because every claim the bar makes is geometric and happy-dom has no layout:
 *   - `getBoundingClientRect()` is all zeros there, so `TransportBar.tsx:123` takes its
 *     `rect.width > 0 ? … : 0` fallback and every track click seeks to 0. No test anywhere
 *     proves a click lands at the right SECOND.
 *   - `jumpPillDirection` reads `playheadY (0) < viewTop (0) + 8` and answers `'up'`
 *     unconditionally (`thread/rail-layout.ts:180`), so the pill's direction is untestable.
 *   - `duration` is only ever written from an RPC `state`/`time` event
 *     (`playerSingleton.ts:115-126`), so with no guest there is no fill, no ticks, and
 *     `TransportBar.tsx:120` swallows every track click. That is why the geometry gates are
 *     the OPT-IN half: not preference, necessity.
 * Every transport gate below carries its own anti-vacuity premise (and two carry a live
 * counterfactual that forces the predicate red and back) — a gate that cannot fail is how
 * #169 shipped in the first place.
 *
 * Run: pnpm smoke:thread   (after `pnpm exec electron-vite build && pnpm rebuild:electron`)
 *      SMOKE_PLAYBACK=1 pnpm smoke:thread   (adds the live-guest half)
 *      SMOKE_FORCE_SWAP=1 pnpm smoke:thread (the #213 gate — implies SMOKE_PLAYBACK)
 *
 * NOTE: The watch page may show a consent/bot wall on a fresh `persist:yt-player`
 * partition. The CI-safe checks tolerate it (insertCSS + guest run regardless of
 * consent state), but SMOKE_PLAYBACK=1 may need a manual consent dismiss first.
 *
 * @see scripts/capture-smoke.mjs (reference launch pattern — L6 task)
 * @see scripts/pdf-multipage-smoke.mjs (the per-gate `gate()` / premise-assertion idiom)
 * @see docs/specs/v0.3-youtube-webview-player.md §10 (testing spec)
 * @see docs/plans/v0.8.2-composer-dataloss.md §3.3 (Task B4)
 * @see adrs/0064-shared-transport-state.md
 * @see adrs/0016-webview-youtube-player.md (supersedes ADR 0015)
 * @see adrs/0008-loopback-http-shell.md (loopback origin contract)
 * @issue utof/linsae#169
 */
import { strict as assert } from 'node:assert'
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron } from 'playwright'

const VIDEO_ID = 'M7lc1UVf-VE'
const VIDEO_TITLE = 'Smoke Video'

/**
 * The #213 gate (spec §8.3): force the guest to commit a SECOND document, so the live-guest
 * half below measures whether the host RE-ARMS its channel rather than whether it got lucky on
 * the first load. See `forceDocumentSwap` for the mechanism and why it is a `src` reassignment
 * rather than session interception.
 */
const FORCE_SWAP = process.env.SMOKE_FORCE_SWAP === '1'

/**
 * `SMOKE_FORCE_SWAP=1` IMPLIES `SMOKE_PLAYBACK=1` (spec §8.3 step 0), and that is not a
 * convenience. Everything the gate measures — `transportDuration`, the SKIP-vs-FAIL split — is
 * inside the `if (!SMOKE_PLAYBACK)` branch below, and every live gate's default is
 * `SMOKE_PLAYBACK ? 'FAIL' : 'SKIP'`. Without the implication, `SMOKE_FORCE_SWAP=1` on its own
 * performs the swap, skips every gate that could see the consequences, and exits 0 — a green
 * run over the exact defect the flag exists to expose.
 */
const SMOKE_PLAYBACK = process.env.SMOKE_PLAYBACK === '1' || FORCE_SWAP

/**
 * Second video, seeded only under SMOKE_PLAYBACK, for the rate-survives-a-guest-reload
 * gate. "Me at the zoo" is 19 seconds — the shortest clip that is certain to still exist,
 * so the second page load costs a fraction of the first.
 */
const VIDEO_ID_B = 'jNQXAC9IVRw'
const VIDEO_TITLE_B = 'Smoke Video B'

/**
 * Timestamps for the seeded anchored comment-notes. Six notes, FIVE distinct values —
 * `12` appears twice, so a tick count of five is what proves `markerPositions`'
 * de-duplication rather than merely "some ticks rendered".
 *
 * The `0` is load-bearing: `activeClusterIndex(clusters, currentTime)` needs a cluster at
 * or before the playhead, and the playhead sits at 0 until something plays. Without a
 * `t: 0` note `activeIdx` is `-1`, `measurePill` finds no row and sets the direction to
 * null — and the follow gate below could never fail.
 */
const ANCHOR_TS = [0, 5, 12, 12, 30, 45]
/** The distinct members of {@link ANCHOR_TS}, ascending — one scrubber tick each. */
const UNIQUE_TS = [0, 5, 12, 30, 45]
/** Anchorless comment-notes, purely to make the notes column taller than its viewport. */
const ANCHORLESS_COUNT = 8

/**
 * Where on the scrubber track the click→seek gate aims, as a fraction of the width.
 * Chosen far from both ends and from every seeded tick (all of which fall under 25% of a
 * 3½-minute video): the happy-dom failure this gate exists to catch resolves to fraction
 * 0, and 0.62 × duration is not within any plausible tolerance of 0.
 */
const SEEK_FRACTION = 0.62

// Throwaway profile so the smoke never pollutes the real userData dir.
const userDataDir = mkdtempSync(join(tmpdir(), 'linsae-thread-smoke-'))

const app = await electron.launch({
  args: ['out/main/index.js', `--user-data-dir=${userDataDir}`],
})

// Track per-check results for the final summary block.
const results = {
  loopbackOrigin: 'FAIL',
  threadOpened: 'FAIL',
  webviewPresent: 'FAIL',
  chromeHidden: 'FAIL',
  rectNonZero: 'FAIL',
  capturePng: 'FAIL',
  // ── transport (B4 · #169) — CI-safe: layout only, no guest needed ──────────
  transportBarPresent: 'FAIL',
  transportBarNotCovered: 'FAIL',
  followCrossesPanes: 'FAIL',
  rateBadgeCycles: 'FAIL',
  // ── the #213 forced swap's own PREMISE (SMOKE_FORCE_SWAP=1) ────────────────
  // Everything below is measured under "the homepage committed as the FIRST document". If that
  // did not happen the run silently degrades to the ordinary single-document scenario, six
  // PASSes print and the process exits 0 over the exact defect the flag exists to expose — so
  // the premise is a recorded gate, not a log line. See `forceDocumentSwap` step 2.
  forcedSwapCommitted: FORCE_SWAP ? 'FAIL' : 'SKIP',
  // ── transport — live guest only ───────────────────────────────────────────
  transportDuration: SMOKE_PLAYBACK ? 'FAIL' : 'SKIP',
  fullscreenSelector: SMOKE_PLAYBACK ? 'FAIL' : 'SKIP',
  transportPlayPause: SMOKE_PLAYBACK ? 'FAIL' : 'SKIP',
  scrubberClickSeeks: SMOKE_PLAYBACK ? 'FAIL' : 'SKIP',
  markerTicksPositioned: SMOKE_PLAYBACK ? 'FAIL' : 'SKIP',
  rateSurvivesGuestReload: SMOKE_PLAYBACK ? 'FAIL' : 'SKIP',
}
/** Per-gate one-liner shown beside the status in the summary. */
const notes = {}

/**
 * Run one gate, trapping its failure so the gates after it still run. The process still
 * exits non-zero — the summary at the bottom throws once, naming every failure. Borrowed
 * from `scripts/pdf-multipage-smoke.mjs:403`: for a diagnostic smoke, "which of these
 * broke" is the whole product, and a script that dies on its first assertion hides it.
 */
async function gate(key, label, fn) {
  try {
    const note = await fn()
    results[key] = 'PASS'
    notes[key] = note ?? ''
    console.log(`thread-smoke [PASS] ${label}${note ? ` — ${note}` : ''}`)
  } catch (err) {
    results[key] = 'FAIL'
    notes[key] = err?.message ?? String(err)
    console.log(`thread-smoke [FAIL] ${label} — ${err?.message ?? err}`)
  }
}

/** Mark a gate skipped with the reason, loudly — a silent skip is indistinguishable from a pass. */
function skipGate(key, why) {
  results[key] = 'SKIP'
  notes[key] = why
  console.log(`thread-smoke [SKIP] ${key} — ${why}`)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * `m:ss` / `h:mm:ss` → seconds. Mirrors `parseClock` (`src/renderer/src/lib/time.ts:16`)
 * rather than importing it: this is a plain `.mjs` run by bare node and that module is
 * TypeScript. A drift surfaces as a gate failure, not as silence.
 */
function parseClockText(text) {
  const m = String(text)
    .trim()
    .match(/^(?:(\d+):)?(\d{1,2}):([0-5]\d)$/)
  if (!m) return null
  return (m[1] ? Number(m[1]) * 3600 : 0) + Number(m[2]) * 60 + Number(m[3])
}

/**
 * The feed card's thread affordance for one video.
 *
 * NOT the bottom-row button: it carries the same `open video notes` label on EVERY card
 * (`feed/MediaFeedNote.tsx:251`), so it is ambiguous the moment a second video is seeded.
 * The thumbnail button (`:166`) carries the title — or the raw video id, because `:78`
 * falls back to it until the `videoSources` query resolves, which is a real race here.
 *
 * ANCHORED, both ends: "Smoke Video" is a prefix of "Smoke Video B", so an unanchored
 * pattern matches both cards and Playwright's strict mode rejects the locator.
 */
function openThreadButton(win, videoId, title) {
  return win.getByRole('button', {
    name: new RegExp(`^open notes for (${title}|${videoId})$`, 'i'),
  })
}

/** Where the forced swap parks the guest first — see `forceDocumentSwap`. */
const YT_HOME = 'https://www.youtube.com/'

/**
 * SMOKE_FORCE_SWAP=1 — make the guest commit TWO documents, deterministically (spec §8.3).
 *
 * #213 is the host latching its RPC channel to whichever document committed FIRST and never
 * re-arming. In the wild the first document is a consent wall or the redirect it bounces
 * through, so the watch page that follows talks to nobody; the player looks alive (`play()`
 * bypasses the RPC, and the chrome-hiding CSS re-fires outside the handshake) while duration,
 * pause, seek and rate are all dead. It reproduces on maybe one run in seven, which is why no
 * gate ever caught it. This makes it 1 in 1: park the guest on the YouTube HOME PAGE, let its
 * runtime come up there, then send it to the watch page. The homepage is not a contrivance —
 * it is literally where the consent wall redirects.
 *
 * Three properties this leans on, none of them optional:
 *
 *  - It reassigns `wv.src` DIRECTLY rather than calling the host's `load()`. `load()` runs
 *    `teardown()`, which is the fix; routing through it would test nothing.
 *  - It hijacks the FIRST load, in-page, on the same rAF tick the element's `src` appears. The
 *    homepage has to be the first document to COMMIT: the host latches on the first
 *    `dom-ready` it sees, so if the watch page wins the race the channel is good, the duration
 *    arrives, and the gate passes on broken code. `waitForFunction` polls inside the renderer,
 *    so the assignment lands without a round-trip's worth of latency.
 *  - It waits for `window.__linsaeGuest` before swapping back — bounded, because on the code
 *    this exists to fail the sentinel never arrives. That sentinel is published LAST by the
 *    guest runtime, after the port receiver is installed, so it means "armed" rather than "the
 *    script started". The `href` term is what stops the outgoing watch document — which also
 *    carries the sentinel — from answering for the homepage.
 *  - It RECORDS the premise as the `forcedSwapCommitted` gate, on the fix-independent `href`
 *    and never on the sentinel. Without that, a swap that quietly failed to take leaves the six
 *    live gates measuring an ordinary single-document run and exiting 0 (step 2).
 *
 * NOT session interception (spec §8.3 rules it out with reasons): `webRequest` cannot serve a
 * body, `data:`/`file:` redirects are blocked for top-frame navigations, and
 * `protocol.handle('https', …)` on a `persist:` partition is undocumented and unverified.
 *
 * The swap does NOT exercise the C6 watchdog's re-arm. If a run ever shows an ack with no
 * duration behind it, that is the known "a re-armed channel gets no initial snapshot" gap
 * (`attachVideo` early-returns on the same `<video>`, so no `ready` and no initial `state`),
 * not a transport failure. Do not read an `ack` as "video ready" either — the guest acks from a
 * consent page with no `<video>` at all (contract C3).
 *
 * MEASURED 2026-08-03, this script against the pre-fix source (`d06c951`) in a detached
 * worktree, versus the same script on the branch:
 *   - pre-fix  3/3 `transportDuration FAIL`, each with `consent:false, hasVideo:true` and the
 *              guest's own `<video>` reporting 1343.661s while the bar read nothing. Never SKIP.
 *   - post-fix 3/3 PASS on all six live gates.
 * The differential is visible in this function's own log line: pre-fix the homepage reports
 * `{g: false}` — the host refuses to re-inject, which IS the defect — post-fix `{g: true}`.
 *
 * @issue utof/linsae#213
 */
async function forceDocumentSwap(win) {
  // Step 1. Hijack the first load, in the same rAF tick the `src` appears. Returning the old
  // value out of that tick is deliberate: it is the only moment the watch URL is guaranteed to
  // still be readable, and step 3 needs it verbatim rather than a second guess at `watchUrl()`.
  //
  // ONE assignment is not enough, and the reason is Electron's, not ours. `SrcAttribute.parse()`
  // (`lib/renderer/web-view/web-view-attributes.ts` @ v42.5.0) reads:
  //
  //     if (this.webViewImpl.guestInstanceId == null) {
  //       if (this.webViewImpl.beforeFirstNavigation) {
  //         this.webViewImpl.beforeFirstNavigation = false;
  //         this.webViewImpl.createGuest();          // ← snapshots src via buildParams()
  //       }
  //       return;                                    // ← everything else here is DROPPED
  //     }
  //
  // `load()`'s own assignment is the one that calls `createGuest()`, and `guestInstanceId` only
  // arrives an IPC round-trip later (`createGuest().then(attachGuestInstance)`), so an
  // assignment landing in between hits that bare `return` and vanishes — measured: the first
  // build of this gate set the homepage, was silently ignored, and the guest reported
  // `location.href` still on `/watch` 30s later. Re-asserting past the window is the fix, and
  // re-assigning the SAME value works because `SrcAttribute`'s MutationObserver exists
  // precisely to catch a same-value write.
  //
  // Bounded to ~400ms (5 × 80ms), not "until it takes": each accepted assignment supersedes the
  // navigation the previous one started. HTML Standard §7.4.2.2 "Navigate", step 20 — the
  // normative sentence is "Set the ongoing navigation for navigable to navigationId."; the
  // consequence is its attached NOTE, quoted separately because it is a note and not normative
  // text: "This will have the effect of aborting other ongoing navigations of navigable, since
  // at certain points during navigation changes to the ongoing navigation will cause further
  // work to be abandoned." So an unbounded loop would keep restarting the homepage load and it
  // could never commit.
  //
  // The 400ms itself is REASONING, not measurement, and is deliberately not dressed as one: it
  // is long enough to outlast the `createGuest()` → attach-IPC window described above (the only
  // window that swallows an assignment) and short enough that no network document commits
  // underneath it. What IS measured is the outcome either side of the bound, from two different
  // sources: that ONE assignment is dropped is spec §8.3, correction 1; that FIVE are not is
  // this file's own runs, recorded in `forceDocumentSwap`'s docblock above — every one of them
  // reports the guest on the homepage. Reading `wv.getWebContentsId()` back would make 400ms a
  // ceiling rather than a schedule; not done here because it would change working, measured
  // code (utof/linsae#219).
  const hijacked = await win.waitForFunction(
    (home) => {
      const wv = document.querySelector('#yt-player-wrapper webview')
      const src = wv?.getAttribute('src') ?? ''
      if (!src.includes('/watch')) return null
      wv.src = home
      return src
    },
    YT_HOME,
    { timeout: 30_000, polling: 'raf' },
  )
  const watchSrc = await hijacked.jsonValue()
  for (let i = 0; i < 5; i++) {
    await sleep(80)
    await win.evaluate((home) => {
      const wv = document.querySelector('#yt-player-wrapper webview')
      if (wv) wv.src = home
    }, YT_HOME)
  }
  console.log(`thread-smoke: [force-swap] hijacked the first load — ${YT_HOME} before ${watchSrc}`)

  // Step 2. Wait for the guest runtime to be ARMED on the homepage document. `__linsaeGuest` is
  // published LAST by the runtime, after the port receiver is installed, so it means "armed"
  // rather than "the script started". The `href` term is what stops the outgoing watch
  // document — which carries the sentinel too — from answering for the homepage.
  //
  // The two terms are polled together but they are NOT the same claim, and only ONE of them is
  // the premise the gate below records:
  //   - `href` is FIX-INDEPENDENT. It is the guest reporting its own `location` over
  //     `executeJavaScript`, which answers whether or not the host ever injected anything.
  //   - `g` is the host's injection — precisely what is broken on the code this run exists to
  //     falsify, where the host refuses to re-inject and the sentinel is legitimately absent.
  // Waiting on `g` alone therefore cannot tell "the homepage never committed" from "the host
  // refused to inject": on the pre-fix source neither breaks the loop, both read as 60 × 500ms
  // of silence, and the swap-back happens 30s later for no reason. So break on `g` when it
  // comes, and otherwise stop `HOME_GRACE_POLLS` after the homepage is first seen COMMITTED —
  // a committed homepage is the only thing step 3 actually needs.
  //
  // "Committed" is `^https?:` AND NOT `/watch`, and the first half is load-bearing rather than
  // decoration: `about:blank` is the guest's initial empty document — what `location.href`
  // reports between attach and the homepage's commit — and `!includes('/watch')` alone accepts
  // it. Counting `about:blank` polls would start the grace clock before the homepage exists,
  // when the clock is there to bound the HOST's injection. The loud failure mode is a flake
  // (the grace expires on `about:blank`, and the premise gate FAILs saying "the guest reports
  // about:blank"). The quiet one is worse and is why this is a blocker rather than a tidy-up: a
  // grace spent on `about:blank` can also expire before the homepage's `dom-ready`, step 3
  // fires first, the pre-fix build latches `rpc` to the WATCH page, and all six live gates pass
  // on broken code with `forcedSwapCommitted` passing too — #213 re-entering one layer up,
  // through the door this bound opened.
  //
  // The bound therefore has to cover commit → `dom-ready` → `safeExec(guestRuntime)`, not
  // commit alone: 20 × 500ms = 10s. That 10s is REASONING, like the 400ms above, and is not
  // dressed as measurement — what IS measured is narrower, from the per-poll `href` logged
  // below over 4 cold-partition runs (2 branch, 2 pre-fix `d06c951`, 2026-08-03):
  //   - the homepage was ALREADY committed at poll 1 in 4/4; `about:blank` was never observed,
  //     so the tightened term has so far cost nothing and prevented nothing on this machine —
  //     it is insurance against a slower cold load, not a fix for an observed flake;
  //   - on the branch the sentinel arrived at poll 2 — ONE poll of grace consumed, so 20 is
  //     ~20× the observed need and 10 would also have sufficed here;
  //   - on the pre-fix source it never arrives, the loop ends at poll 21, and the raise costs
  //     that run ~5s (10.5s vs 5.5s). That asymmetry is the whole argument: too-long only
  //     lengthens a run that is already failing, too-short greens a broken build.
  // The 60-poll ceiling still caps the genuinely-broken case at 30s, and this still cuts ~20s
  // of the ~25s the unbounded wait used to spend on every falsification run.
  const HOME_GRACE_POLLS = 20
  let armed = null
  let homePolls = 0
  for (let i = 0; i < 60; i++) {
    await sleep(500)
    armed = await win.evaluate(async () => {
      const wv = document.querySelector('#yt-player-wrapper webview')
      if (!wv) return null
      try {
        return await wv.executeJavaScript('({g: !!window.__linsaeGuest, href: location.href})')
      } catch (_e) {
        return null
      }
    })
    // Per-poll, not just the final reading: the poll at which the homepage commits and the poll
    // at which it arms are the only evidence that HOME_GRACE_POLLS is a bound and not a guess,
    // and they are re-measured by every run rather than trusted from this comment.
    console.log(`thread-smoke: [force-swap] poll ${i + 1}/60 — ${JSON.stringify(armed)}`)
    const onHome = !!armed && /^https?:/.test(armed.href) && !armed.href.includes('/watch')
    if (onHome) homePolls++
    if (onHome && armed.g === true) break
    if (homePolls > HOME_GRACE_POLLS) break
  }
  // `g` is a DIAGNOSTIC, never an assertion. On the code this run exists to fail the host may
  // refuse to inject into the homepage at all, so `{g: false}` is the EXPECTED pre-fix reading;
  // a throw on it would kill the run before any gate recorded anything, turning an observable
  // FAIL into a crash — and gating on it would fail here for the very reason the live gates are
  // supposed to discover, converting the falsification into a tautology.
  console.log(`thread-smoke: [force-swap] homepage guest = ${JSON.stringify(armed)}`)

  // The premise, RECORDED rather than logged — the point of B1. Everything the six live gates
  // measure under SMOKE_FORCE_SWAP is conditional on the homepage having committed first; if it
  // did not, this function returns normally, the gates run against a single-document scenario,
  // six PASSes print and the process exits 0. That is not hypothetical: the first build of this
  // gate set the homepage, had it silently dropped (step 1), and the guest sat on `/watch` for
  // 30s — caught by a human reading a log line. `skipGate`'s rule ("a silent skip is
  // indistinguishable from a pass") is the same rule, one level up.
  //
  // This is a PREMISE check, not a fix check: it must pass on the pre-fix source as well as on
  // the branch. Hence `href` and never `g` — see the paragraph above.
  //
  // RESIDUAL, named rather than fixed: this proves "on a committed non-watch document at
  // swap-back time", not that the homepage committed BEFORE the watch page. Ordering still
  // rests on step 1's 400ms argument, not on an observation (utof/linsae#220).
  await gate('forcedSwapCommitted', 'the homepage committed as the FIRST document', () => {
    assert.ok(
      armed,
      'the guest never answered executeJavaScript — the premise of every live gate below is unverified, so their results say nothing about the re-arm',
    )
    assert.match(
      armed.href,
      /^https?:/,
      `the guest reports ${armed.href}, which is not a committed http(s) document — there is no second document for the host to re-arm against`,
    )
    assert.ok(
      !armed.href.includes('/watch'),
      `the guest is still on ${armed.href} — the homepage assignment never took, so the watch page is the FIRST document and this run cannot see #213 at all`,
    )
    return `guest on ${armed.href} before the swap back (__linsaeGuest ${armed.g} — diagnostic, not gated)`
  })

  // Step 3. Back to the watch page. This is the document the host must re-arm against.
  await win.evaluate((src) => {
    const wv = document.querySelector('#yt-player-wrapper webview')
    if (wv) wv.src = src
  }, watchSrc)
  console.log(`thread-smoke: [force-swap] second document requested — ${watchSrc}`)
}

try {
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')

  // `playerSingleton` reports guest-runtime and port-transfer trouble to the renderer
  // console and swallows it otherwise (`safeExec`, `safeInsertCSS`, and the `postMessage`
  // try/catch at playerSingleton.ts:190-195). Collect those: when the live half below finds
  // no RPC, they are the difference between "a consent wall ate the port" and a real break.
  // The listener survives the reload — it is bound to the Page, not the document.
  const playerLogs = []
  win.on('console', (m) => {
    const t = m.text()
    if (t.includes('[player]')) playerLogs.push(t)
  })

  // ── 1. Assert loopback origin (ADR 0008) ──────────────────────────────────
  const origin = await win.evaluate(() => location.origin)
  console.log(`thread-smoke: document origin = ${origin}`)
  assert.ok(
    origin.startsWith('http://127.0.0.1'),
    `renderer must be served over loopback http (got ${origin})`,
  )
  results.loopbackOrigin = 'PASS'
  console.log('thread-smoke [PASS] loopback origin')

  // ── 2. Seed a source note + video_sources row via real IPC ─────────────────
  // …and (B4) the thread's own comment-notes. The transport gates need a thread with
  // anchored timestamps — for the scrubber's marker ticks, and for an active cluster the
  // jump pill can point at — plus enough body text that the notes column scrolls. Bodies
  // must all differ: `src/main/save-note.ts` throws on a duplicate body-derived slug.
  await win.evaluate(
    async ({ videoId, videoIdB, title, titleB, anchors, anchorless, seedB }) => {
      const upsert = (id, t) =>
        window.api.videoSources.upsert({
          videoId: id,
          sourceKind: 'youtube',
          title: t,
          channel: 'Chan',
          thumbnailUrl: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
        })
      const src = await window.api.notes.create({
        body: '',
        type: 'source',
        source_kind: 'youtube',
        source_locator: { media: 'youtube', video_id: videoId },
      })
      await upsert(videoId, title)

      const pad = 'Body text long enough to give the row real height in the notes column.'
      for (const [i, t] of anchors.entries()) {
        await window.api.notes.create({
          body: `anchored note ${i + 1} at t=${t}. ${pad}`,
          type: 'claim',
          source_kind: 'youtube',
          source_locator: { media: 'youtube', video_id: videoId, t },
          commentOn: src.slug,
        })
      }
      for (let i = 0; i < anchorless; i++) {
        await window.api.notes.create({
          body: `anchorless note ${i + 1}. ${pad}`,
          type: 'claim',
          source_kind: 'youtube',
          source_locator: { media: 'youtube', video_id: videoId },
          commentOn: src.slug,
        })
      }

      if (seedB) {
        await window.api.notes.create({
          body: '',
          type: 'source',
          source_kind: 'youtube',
          source_locator: { media: 'youtube', video_id: videoIdB },
        })
        await upsert(videoIdB, titleB)
      }
    },
    {
      videoId: VIDEO_ID,
      videoIdB: VIDEO_ID_B,
      title: VIDEO_TITLE,
      titleB: VIDEO_TITLE_B,
      anchors: ANCHOR_TS,
      anchorless: ANCHORLESS_COUNT,
      seedB: SMOKE_PLAYBACK,
    },
  )

  // Reload so the renderer re-fetches notes.list and the feed renders the card.
  await win.reload()
  await win.waitForLoadState('domcontentloaded')

  // Recorded BEFORE the thread is opened, and asserted inside the presence gate below.
  // On a fresh profile the dock holds no player pane, so the transport bar is absent
  // here and present after the click — which is the whole of what #169 was: for two
  // milestones the "after" looked like this "before".
  const barBeforeThread = await win.evaluate(
    () => !!document.querySelector('[data-testid="player-pane"] [data-testid="scrubber-track"]'),
  )
  console.log(`thread-smoke: transport bar present before opening a thread = ${barBeforeThread}`)

  // ── 3. Open the thread ─────────────────────────────────────────────────────
  // The MediaFeedNote thumbnail is the thread affordance (see openThreadButton).
  // Wait with a generous timeout to allow React Query to settle.
  try {
    const btn = openThreadButton(win, VIDEO_ID, VIDEO_TITLE)
    await btn.waitFor({ timeout: 15000 })
    await btn.click()
    results.threadOpened = 'PASS'
    console.log('thread-smoke [PASS] thread opened')
  } catch (e) {
    const dom = await win.evaluate(() => document.body.innerHTML.slice(0, 4000))
    console.error(`thread-smoke [FAIL] could not find the "open notes for …" button: ${String(e)}`)
    console.error(`thread-smoke DOM snapshot (first 4000 chars):\n${dom}`)
    throw new Error('feed card thread affordance not found — the card did not render')
  }

  // Immediately after the click and BEFORE every poll below, because the swap has to beat the
  // watch page's own `dom-ready` (see `forceDocumentSwap`). Nothing between here and the click
  // may await anything slower than a rAF.
  if (FORCE_SWAP) await forceDocumentSwap(win)

  // ── CI-safe check 1: webview present ──────────────────────────────────────
  // Poll (≤40s, 2s interval) for a <webview> inside #yt-player-wrapper whose
  // src contains youtube.com/watch. NOT an iframe — the new engine is a <webview>.
  console.log('thread-smoke: polling for <webview> inside #yt-player-wrapper …')
  let webviewSrc = null
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 2000))
    const info = await win.evaluate(() => {
      const wv = document.querySelector('#yt-player-wrapper webview')
      const allWebviews = Array.from(document.querySelectorAll('webview')).map((w) => ({
        id: w.id,
        src: w.getAttribute('src') ?? '',
        parent: w.parentElement?.id ?? '',
      }))
      return {
        wrapperExists: !!document.getElementById('yt-player-wrapper'),
        wrapperHtml: document.getElementById('yt-player-wrapper')?.innerHTML?.slice(0, 300) ?? null,
        webviewSrc: wv?.getAttribute('src') ?? null,
        allWebviews,
        playerHostExists: !!document.querySelector('[data-testid="player-host"]'),
      }
    })
    console.log(`thread-smoke: DOM poll ${i + 1}/20 — ${JSON.stringify(info)}`)
    if (info.webviewSrc?.includes('youtube.com/watch')) {
      webviewSrc = info.webviewSrc
      break
    }
    // Also accept a <webview> whose src contains youtube.com (may not have /watch yet)
    if (info.webviewSrc?.includes('youtube.com')) {
      webviewSrc = info.webviewSrc
      // Keep polling — may not have /watch yet; but stop if we find one
      break
    }
  }

  if (!webviewSrc) {
    const finalDom = await win.evaluate(() => ({
      allWebviews: Array.from(document.querySelectorAll('webview')).map((w) =>
        w.getAttribute('src'),
      ),
      bodySnippet: document.body.innerHTML.slice(0, 2000),
    }))
    console.error('thread-smoke [FAIL] <webview> with youtube.com src not found after 40s')
    console.error(`  Final DOM: ${JSON.stringify(finalDom)}`)
    throw new Error('<webview> not found inside #yt-player-wrapper — webview engine did not mount')
  }

  assert.ok(
    webviewSrc.includes('youtube.com'),
    `webview src must contain youtube.com (got ${webviewSrc})`,
  )
  results.webviewPresent = 'PASS'
  console.log(`thread-smoke [PASS] <webview> present — src=${webviewSrc}`)

  // ── CI-safe check 2: CLEAN_CSS chrome hidden ───────────────────────────────
  // Read the computed opacity of .ytp-chrome-bottom and .html5-endscreen via
  // webview.executeJavaScript. Absent elements are treated as PASS (opacity:0 implicit).
  // Note: webview.executeJavaScript is only available on the Electron WebviewElement,
  // not via Playwright's win.evaluate. We call it through win.evaluate which accesses
  // the webview DOM element in the renderer's window.
  //
  // POLLED, and run through `gate()` rather than a bare `assert` (v0.8.2 B4). Two changes,
  // neither of them a relaxation — the assertion is identical and it still fails the run:
  //   - one 3s sleep was a race against `insertCSS`, which is fired from the guest's
  //     'dom-ready' (playerSingleton.ts:253-260) and re-fired on every SPA navigation.
  //     Polling to 20s distinguishes "the CSS never applied" from "we looked too early".
  //   - a bare assert here threw past every check below it, so a CLEAN_CSS problem hid the
  //     entire transport suite. "Which of these broke" is the product of a diagnostic smoke
  //     (same reasoning as scripts/pdf-multipage-smoke.mjs:399-412).
  console.log('thread-smoke: checking chrome opacity via webview.executeJavaScript …')

  const readChromeOpacity = () =>
    win.evaluate(async () => {
      const wv = document.querySelector('#yt-player-wrapper webview')
      if (!wv) return { error: 'no webview' }
      try {
        // executeJavaScript returns the evaluated value to the host.
        // Tolerate null selectors (treat as absent → PASS).
        return await wv.executeJavaScript(`
          (function() {
            var chromeBtm = document.querySelector('.ytp-chrome-bottom');
            var endscreen  = document.querySelector('.html5-endscreen');
            return {
              chromeBtmOpacity: chromeBtm
                ? getComputedStyle(chromeBtm).opacity
                : null,
              endscreenOpacity: endscreen
                ? getComputedStyle(endscreen).opacity
                : null
            };
          })()
        `)
      } catch (e) {
        return { error: String(e) }
      }
    })

  const hiddenOrAbsent = (v) => v == null || v === '0'
  let chromeOpacities = null
  for (let i = 0; i < 10; i++) {
    await sleep(2000)
    chromeOpacities = await readChromeOpacity()
    if (
      !chromeOpacities?.error &&
      hiddenOrAbsent(chromeOpacities?.chromeBtmOpacity) &&
      hiddenOrAbsent(chromeOpacities?.endscreenOpacity)
    ) {
      break
    }
  }
  console.log(`thread-smoke: chrome opacity result = ${JSON.stringify(chromeOpacities)}`)

  if (chromeOpacities?.error) {
    // Tolerate executeJavaScript errors (e.g. page not yet loaded) as long as webview exists
    skipGate(
      'chromeHidden',
      `executeJavaScript failed: ${chromeOpacities.error} — the guest page is not reachable`,
    )
  } else {
    await gate('chromeHidden', 'YouTube chrome hidden (CLEAN_CSS applied)', async () => {
      assert.ok(
        hiddenOrAbsent(chromeOpacities?.chromeBtmOpacity),
        `.ytp-chrome-bottom opacity must be '0' or absent after 20s (got '${chromeOpacities?.chromeBtmOpacity}') — CLEAN_CSS's '#movie_player > *:not(.html5-video-container):not(.video-ads)' rule (inject/clean-css.ts:29) did not apply`,
      )
      assert.ok(
        hiddenOrAbsent(chromeOpacities?.endscreenOpacity),
        `.html5-endscreen opacity must be '0' or absent (got '${chromeOpacities?.endscreenOpacity}')`,
      )
      return `chrome-bottom ${chromeOpacities?.chromeBtmOpacity ?? 'absent'}, endscreen ${chromeOpacities?.endscreenOpacity ?? 'absent'}`
    })
  }

  // ── CI-safe check 3: webview bounding rect non-zero ───────────────────────
  // Read the webview element's bounding rect from the renderer DOM (not the guest).
  const webviewRect = await win.evaluate(() => {
    const wv = document.querySelector('#yt-player-wrapper webview')
    if (!wv) return null
    const r = wv.getBoundingClientRect()
    return { x: r.x, y: r.y, width: r.width, height: r.height }
  })

  console.log(`thread-smoke: webview bounding rect = ${JSON.stringify(webviewRect)}`)

  if (!webviewRect || webviewRect.width <= 0 || webviewRect.height <= 0) {
    console.warn(
      `thread-smoke [WARN] webview bounding rect is zero/null (${JSON.stringify(webviewRect)}) — ThreadView may not be in side-by-side layout yet`,
    )
    results.rectNonZero = 'WARN'
    console.log('thread-smoke [WARN] rect check — using fallback rect for capture')
  } else {
    results.rectNonZero = 'PASS'
    console.log(
      `thread-smoke [PASS] webview rect non-zero: ${webviewRect.width}×${webviewRect.height}`,
    )
  }

  // ── CI-safe check 4: capture round-trip ───────────────────────────────────
  // Call the existing capturePage pipeline via window.api.youtube.capture.
  // Feed it the webview rect (or a fallback if rect was zero).
  const captureRect =
    webviewRect && webviewRect.width > 0 && webviewRect.height > 0
      ? webviewRect
      : { x: 0, y: 0, width: 200, height: 120 }

  const captureResult = await win.evaluate(
    async ({ r, videoId }) => window.api.youtube.capture({ rect: r, videoId, t: 5 }),
    { r: captureRect, videoId: VIDEO_ID },
  )

  const capturePath = captureResult.path
  const captureWidth = captureResult.width
  const captureHeight = captureResult.height

  assert.ok(existsSync(capturePath), `PNG must be written at ${capturePath}`)
  assert.ok(
    Number.isInteger(captureWidth) && captureWidth > 0,
    `capture width must be a positive integer (got ${captureWidth})`,
  )
  assert.ok(
    Number.isInteger(captureHeight) && captureHeight > 0,
    `capture height must be a positive integer (got ${captureHeight})`,
  )

  // Wayland dimension soft-warn (same as original smoke — ADR 0009).
  if (webviewRect && webviewRect.width > 0) {
    const scaleFactor = await app.evaluate(({ screen, BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0]
      return screen.getDisplayMatching(w.getBounds()).scaleFactor
    })
    const expected = Math.round(webviewRect.width * scaleFactor)
    if (captureWidth === expected) {
      console.log(
        `thread-smoke: capture OK ${captureWidth}×${captureHeight} @${scaleFactor}x → ${capturePath}`,
      )
    } else {
      console.warn(
        `thread-smoke: capture PNG OK (${captureWidth}×${captureHeight} @${scaleFactor}x) but width ${captureWidth} !== rect.width×sf (${expected}) — ` +
          `likely Wayland DIP vs physical (ADR 0009). → ${capturePath}`,
      )
    }
  } else {
    console.log(
      `thread-smoke: capture OK ${captureWidth}×${captureHeight} (fallback rect, no dim check) → ${capturePath}`,
    )
  }

  results.capturePng = 'PASS'
  console.log(`thread-smoke [PASS] capture PNG round-trip → ${capturePath}`)

  // ══ TRANSPORT — CI-safe half (B4 · #169) ═══════════════════════════════════
  // Layout only: no guest, no network, no <video>. See the header for why these four
  // cannot live in Vitest.
  const pane = win.locator('[data-testid="player-pane"]')
  const followBtn = pane.locator('button[aria-label="follow playback"]')
  const speedBtn = pane.locator('button[aria-label="playback speed"]')
  const track = pane.locator('[data-testid="scrubber-track"]')
  const jumpPill = win.locator('button[aria-label="jump to now"]')

  await gate('transportBarPresent', 'transport bar mounted in the dock', async () => {
    await track.waitFor({ timeout: 20000 })
    const found = await win.evaluate(() => {
      const p = document.querySelector('[data-testid="player-pane"]')
      const has = (sel) => !!p?.querySelector(sel)
      return {
        pane: !!p,
        // The label flips with playback state (TransportBar.tsx:132) — accept either.
        playPause: has('button[aria-label="play"]') || has('button[aria-label="pause"]'),
        speed: has('button[aria-label="playback speed"]'),
        fullscreen: has('button[aria-label="fullscreen"]'),
        follow: has('button[aria-label="follow playback"]'),
        track: has('[data-testid="scrubber-track"]'),
        // The bar belongs to the DOCK now. A copy left in the centre stage would mean two
        // live transports fighting over one singleton.
        strayInThread: !!document.querySelector(
          '[data-testid="thread-scroll"] [data-testid="scrubber-track"]',
        ),
      }
    })
    assert.equal(
      barBeforeThread,
      false,
      'the transport bar was ALREADY in the DOM before any thread was opened — this gate is measuring something other than the pane it thinks it is',
    )
    for (const k of ['pane', 'playPause', 'speed', 'fullscreen', 'follow', 'track']) {
      assert.ok(
        found[k],
        `no ${k} inside [data-testid="player-pane"] (found ${JSON.stringify(found)})`,
      )
    }
    assert.equal(found.strayInThread, false, 'a scrubber is still rendered inside ThreadView')
    return 'play/pause · speed · fullscreen · follow · scrubber, all inside the dock pane, none of them present before the thread opened'
  })

  await gate('transportBarNotCovered', 'the webview does not paint over the bar', async () => {
    /** Rects for the four boxes the claim is about, in one round trip. */
    const read = () =>
      win.evaluate(() => {
        const box = (el) => {
          if (!el) return null
          const r = el.getBoundingClientRect()
          return { left: r.left, top: r.top, width: r.width, height: r.height, bottom: r.bottom }
        }
        const p = document.querySelector('[data-testid="player-pane"]')
        const trk = p?.querySelector('[data-testid="scrubber-track"]')
        return {
          pane: box(p),
          host: box(document.querySelector('[data-testid="player-host"]')),
          wrapper: box(document.getElementById('yt-player-wrapper')),
          // TransportBar's root is the flex row the track sits in (TransportBar.tsx:128).
          bar: box(trk?.parentElement),
        }
      })
    /** Three frames: syncBounds reads the host rect on one frame and writes the wrapper on it. */
    const settle = () =>
      win.evaluate(
        () =>
          new Promise((r) =>
            requestAnimationFrame(() =>
              requestAnimationFrame(() => requestAnimationFrame(() => r(null))),
            ),
          ),
      )

    const g = await read()
    for (const k of ['pane', 'host', 'wrapper', 'bar']) {
      assert.ok(
        g[k] && g[k].width > 0 && g[k].height > 0,
        `${k} has no box: ${JSON.stringify(g[k])}`,
      )
    }
    assert.ok(g.bar.height >= 20, `the bar is ${g.bar.height}px tall — collapsed, not laid out`)
    // The fixed wrapper tracks the host placeholder rect each frame (playerSingleton.ts:150).
    for (const k of ['left', 'top', 'width', 'height']) {
      assert.ok(
        Math.abs(g.wrapper[k] - g.host[k]) <= 1,
        `the webview wrapper's ${k} is ${g.wrapper[k]} but the host's is ${g.host[k]} — syncBounds is not on this host`,
      )
    }
    // …and the host is the SHRUNKEN box (`flex: 1`), not the whole pane. If it were still
    // `height: 100%` the bar would have nowhere to be.
    assert.ok(
      g.pane.height - g.host.height >= g.bar.height,
      `the host is ${g.host.height}px of a ${g.pane.height}px pane — it did not yield the ${g.bar.height}px the bar needs`,
    )
    assert.ok(
      g.wrapper.bottom <= g.bar.top + 0.5,
      `the wrapper's bottom (${g.wrapper.bottom}) is past the bar's top (${g.bar.top}) — the guest paints over the transport`,
    )

    // ── Counterfactuals: force each claim red, in the live tree, then restore ──
    // Cheaper and more honest than "reasoning that it could fail": the predicates are
    // exercised against the layout that would break them. `setAttribute('style', …)`
    // restores byte-for-byte — React will not re-apply a style object that never changed.
    const savedStyle = await win.evaluate(() => {
      const h = document.querySelector('[data-testid="player-host"]')
      const s = h.getAttribute('style')
      h.style.flex = 'none'
      h.style.height = `${Math.round(h.getBoundingClientRect().height - 40)}px`
      return s
    })
    await settle()
    const shrunk = await read()
    assert.ok(
      Math.abs(shrunk.wrapper.height - shrunk.host.height) <= 1 &&
        shrunk.wrapper.height <= g.wrapper.height - 30,
      `shrinking the host by 40px left the wrapper at ${shrunk.wrapper.height}px (host ${shrunk.host.height}px, was ${g.wrapper.height}px) — the rAF loop is not following the host, so the equality above proves nothing`,
    )

    await win.evaluate(() => {
      document.querySelector('[data-testid="player-host"]').style.marginBottom = '-60px'
    })
    await settle()
    const covered = await read()
    assert.ok(
      covered.wrapper.bottom > covered.bar.top + 0.5,
      'pulling the bar 60px up under the host did NOT trip the disjointness check — the check cannot fail',
    )

    await win.evaluate((s) => {
      const h = document.querySelector('[data-testid="player-host"]')
      if (s === null) h.removeAttribute('style')
      else h.setAttribute('style', s)
    }, savedStyle)
    await settle()
    const restored = await read()
    assert.ok(
      restored.wrapper.bottom <= restored.bar.top + 0.5 &&
        Math.abs(restored.wrapper.height - g.wrapper.height) <= 1,
      'the pane did not come back after the counterfactuals — every gate below would be measuring a broken layout',
    )
    return `host ${Math.round(g.host.height)}px + bar ${Math.round(g.bar.height)}px in a ${Math.round(g.pane.height)}px pane; wrapper bottom ${Math.round(g.wrapper.bottom)} ≤ bar top ${Math.round(g.bar.top)}; both counterfactuals went red and restored`
  })

  await gate('followCrossesPanes', 'follow toggle in the dock reaches ThreadView', async () => {
    // The claim: `followOn` is not a button colour. It gates ThreadView's follow
    // auto-scroll AND `jumpPillDirection` (rail-layout.ts:179 returns null while it is
    // true), so with the pre-B3 `const followOn = true` the pill was unreachable in
    // production for two milestones. PlayerPane and ThreadView are SIBLINGS: nothing but
    // the shared store can carry this.
    assert.equal(
      await followBtn.getAttribute('data-active'),
      'true',
      'follow did not start on — the store default moved and the negative step below is no longer a negative',
    )
    assert.equal(await jumpPill.count(), 0, 'the jump pill is showing before anything scrolled')

    // Park the column at the bottom. Twice, 400ms apart: the mount-time follow scroll is
    // `behavior: 'smooth'` (`ThreadView`'s `scrollClusterIntoView`) and overrides a single
    // assignment made while it is still animating.
    const toBottom = () =>
      win.evaluate(() => {
        const el = document.querySelector('[data-testid="thread-scroll"]')
        if (el) el.scrollTop = el.scrollHeight
      })
    await toBottom()
    await sleep(400)
    await toBottom()
    await sleep(400)

    const geom = await win.evaluate(() => {
      const el = document.querySelector('[data-testid="thread-scroll"]')
      const row = el?.querySelector('[data-cluster-index="0"]')
      if (!el || !row) return null
      const v = el.getBoundingClientRect()
      return {
        scrollTop: el.scrollTop,
        scrollable: el.scrollHeight - el.clientHeight,
        viewTop: v.top,
        viewHeight: v.height,
        playheadY: row.getBoundingClientRect().top,
      }
    })
    assert.ok(geom, 'no [data-cluster-index="0"] row — the t:0 cluster did not render')
    assert.ok(geom.scrollable > 200, `the notes column has only ${geom.scrollable}px of scroll`)
    assert.ok(geom.scrollTop > 200, `the column did not scroll (scrollTop ${geom.scrollTop})`)
    // THE anti-vacuity assertion. In happy-dom every rect is zero, so `playheadY < viewTop
    // + 8` is trivially true and the direction always reads 'up'. Here the playhead row has
    // to be genuinely, measurably off the top of the viewport before 'up' means anything.
    assert.ok(
      geom.playheadY < geom.viewTop - 50,
      `the playhead row is only ${(geom.viewTop - geom.playheadY).toFixed(0)}px above the viewport top — under 50px this gate cannot tell a real 'up' from happy-dom's all-zero rects`,
    )
    // Scrolled far past the playhead, and the pill is STILL hidden — because follow is on.
    assert.equal(
      await jumpPill.count(),
      0,
      'the pill is showing while follow is ON — rail-layout.ts:179 is not gating it',
    )

    await followBtn.click()
    await win.waitForFunction(
      () =>
        document
          .querySelector('[data-testid="player-pane"] button[aria-label="follow playback"]')
          ?.getAttribute('data-active') === 'false',
      undefined,
      { timeout: 5000 },
    )
    await jumpPill.waitFor({ timeout: 5000 })

    const rel = await win.evaluate(() => {
      const p = document.querySelector('button[aria-label="jump to now"]').getBoundingClientRect()
      const v = document.querySelector('[data-testid="thread-scroll"]').getBoundingClientRect()
      return (p.top + p.height / 2 - v.top) / v.height
    })
    // 'up' pins the pill to the TOP of the column, 'down' to the bottom — `ThreadView`'s
    // jump-pill wrapper switches `top: 14` for `bottom: 14` on `pillDir`. Reading it back
    // positionally is the only way to see the direction at all.
    assert.ok(
      rel < 0.5,
      `the pill rendered ${(rel * 100).toFixed(0)}% down the column — that is the 'down' placement, but the playhead is above the viewport`,
    )

    // Counterfactual: follow back ON must hide it again. Without this, "the pill appeared"
    // could be true of a pill that is simply always on once the list is scrolled.
    await followBtn.click()
    await win.waitForFunction(
      () => document.querySelectorAll('button[aria-label="jump to now"]').length === 0,
      undefined,
      { timeout: 5000 },
    )
    return `playhead ${Math.round(geom.viewTop - geom.playheadY)}px above the viewport: hidden with follow on → 'up' pill at ${(rel * 100).toFixed(0)}% with follow off → hidden again`
  })

  await gate('rateBadgeCycles', 'speed badge cycles the shared rate', async () => {
    const seen = [(await speedBtn.textContent())?.trim()]
    for (let i = 0; i < 5; i++) {
      const prev = seen[seen.length - 1]
      await speedBtn.click()
      await win.waitForFunction(
        (p) =>
          document
            .querySelector('[data-testid="player-pane"] button[aria-label="playback speed"]')
            ?.textContent?.trim() !== p,
        prev,
        { timeout: 5000 },
      )
      seen.push((await speedBtn.textContent())?.trim())
    }
    // The wrap back to 1× is the point: a badge that merely counted up, or one reading a
    // prop that never changed, cannot produce this sequence.
    assert.deepEqual(
      seen,
      ['1×', '1.25×', '1.5×', '1.75×', '2×', '1×'],
      `the badge read ${JSON.stringify(seen)} — RATES is [1, 1.25, 1.5, 1.75, 2], cycling (transportState.ts:9)`,
    )
    return seen.join(' → ')
  })

  // ══ TRANSPORT — live-guest half (SMOKE_PLAYBACK=1) ═════════════════════════
  if (!SMOKE_PLAYBACK) {
    console.log(
      'thread-smoke [SKIP] live-guest transport gates (duration/seek/ticks/rate) — set SMOKE_PLAYBACK=1',
    )
  } else {
    console.log(
      'thread-smoke: SMOKE_PLAYBACK=1 — waiting for the guest RPC to deliver a duration …',
    )

    /** Evaluate `code` inside the guest page; null on any failure (teardown/nav races). */
    const inGuest = (code) =>
      win.evaluate(async (src) => {
        const wv = document.querySelector('#yt-player-wrapper webview')
        if (!wv) return null
        try {
          return await wv.executeJavaScript(src)
        } catch (_e) {
          return null
        }
      }, code)

    /** One snapshot of the guest's media element — the ground truth every gate below reads. */
    const VIDEO_SNAPSHOT = `(function(){
      var v = document.querySelector('#movie_player video');
      if (!v) return null;
      return { duration: isFinite(v.duration) ? v.duration : 0, currentTime: v.currentTime, paused: v.paused, rate: v.playbackRate };
    })()`
    const guestVideo = async () => inGuest(VIDEO_SNAPSHOT)

    /** Where the guest actually ended up — the evidence that separates a wall from a break. */
    const GUEST_DIAG = `(function(){
      var v = document.querySelector('#movie_player video');
      return {
        href: location.href,
        consent: !!document.querySelector('ytd-consent-bump-v2-lightbox'),
        hasPlayer: !!document.getElementById('movie_player'),
        hasVideo: !!v
      };
    })()`

    /**
     * The HOST's view of duration, off the bar's own readout — 0 until an RPC `state`/`time`
     * event lands (`playerSingleton.ts:115-126`, `:185-188`).
     *
     * This, not "the guest has a <video>", is the precondition for every gate below. A guest
     * can be playing perfectly while the host knows nothing: `play()` goes straight in over
     * `executeJavaScript` (`:315`) whereas pause/seek/rate are RPC invokes and duration only
     * ever arrives as an RPC event. An earlier revision of this gate keyed on the guest video
     * and produced four confident FAILs pointing at the transport for a port that was never
     * connected.
     */
    const hostDurationSec = async () => {
      const txt = await pane.locator('[data-testid="transport-time"]').textContent()
      return parseClockText(String(txt).split('/')[1]) ?? 0
    }

    let media = null
    let hostD = 0
    for (let i = 0; i < 30; i++) {
      media = await guestVideo()
      hostD = await hostDurationSec()
      if (hostD > 0 && media && media.duration > 0) break
      if (i % 5 === 0) {
        console.log(
          `thread-smoke: guest poll ${i + 1}/30 — host duration ${hostD}s, guest ${JSON.stringify(media)}`,
        )
      }
      await sleep(2000)
    }

    if (hostD <= 0) {
      const diag = await inGuest(GUEST_DIAG)
      console.log(`thread-smoke: guest diagnostic = ${JSON.stringify(diag)}`)
      console.log(`thread-smoke: [player] console lines = ${JSON.stringify(playerLogs)}`)
      // WALL OR BREAK — the one question this branch exists to answer, now asked of the guest
      // instead of guessed from its DOM (spec §8.4). The guest emits `needs-interaction` on
      // every consent-lightbox transition; the host records it and mirrors it onto the wrapper
      // as `data-needs-interaction`, which is the only host state a `win.evaluate` can reach.
      //
      // Replaces `!diag || diag.consent || !diag.hasVideo || !diag.href?.includes('/watch')`.
      // That predicate skipped strictly MORE, and every extra term skipped on evidence that a
      // dead transport produces too: a host with no channel sees no duration, no `<video>` news
      // and no navigation news, so "the guest is not where I expected" was as consistent with
      // #213 as with a wall. Skipping is the dangerous direction — a SKIP satisfies "the run did
      // not pass" while proving nothing, which is how #169 shipped. The raw `diag` stays in the
      // failure message below so a human still sees the href and the `<video>`.
      //
      // NOT authoritative after ANY re-arm of an already-wired document. The C6 watchdog is the
      // loudest such path, not the only one — the ordinary ack-timeout retry reaches the same
      // state: `retryLater` re-enters `handshake()`, whose `safeExec(guestRuntime(token))` hits
      // the guest runtime's `if (window.__linsaeGuest) { arm(NONCE); return; }` short-circuit,
      // so the new port lands in `initPort` and the `wireDocument()` it calls no-ops on
      // `domWired`. `checkConsent()` therefore never re-runs and `lastConsentActive` stays
      // latched in the guest's closure. Concretely: on a walled document whose FIRST attempt's
      // ack times out, the attempt that does publish reads false here — and false fails rather
      // than skips, which is the safe direction and the reason this is a readout, not a proof.
      // (Mirrors `PlayerInstance.needsInteraction`'s TSDoc in `playerSingleton.ts`.)
      //
      // `insertCSS` re-fires on every dom-ready and is NOT evidence the RPC came up. Neither is
      // an `ack`: the guest acks from a consent page with no `<video>` at all (contract C3).
      const walled = await win.evaluate(
        () => document.getElementById('yt-player-wrapper')?.dataset.needsInteraction === 'true',
      )
      const why = `the host never received a duration after 60s (guest ${JSON.stringify(diag)}, media ${JSON.stringify(media)}, logs ${JSON.stringify(playerLogs)})`
      if (walled) {
        for (const k of [
          'transportDuration',
          'fullscreenSelector',
          'transportPlayPause',
          'scrubberClickSeeks',
          'markerTicksPositioned',
          'rateSurvivesGuestReload',
        ]) {
          skipGate(
            k,
            `${why} — the guest reported needs-interaction: a consent/sign-in wall on the persist:yt-player partition`,
          )
        }
      } else {
        // No guest ever reported a wall and the host still knows nothing: that is the
        // MessagePort RPC itself, and it is a real failure, not an environment artefact. Fail
        // it rather than skipping, and skip only the dependants.
        await gate('transportDuration', 'the guest duration reached the bar', async () => {
          assert.fail(
            `${why} — no needs-interaction from the guest, so this is the host↔guest handshake in playerSingleton.ts, not a consent wall`,
          )
        })
        for (const k of [
          'fullscreenSelector',
          'transportPlayPause',
          'scrubberClickSeeks',
          'markerTicksPositioned',
          'rateSurvivesGuestReload',
        ]) {
          skipGate(k, 'depends on transportDuration, which FAILED')
        }
      }
    } else {
      const D = media.duration
      console.log(
        `thread-smoke: guest media ready — ${JSON.stringify(media)} (host reads ${hostD}s)`,
      )

      await gate('transportDuration', 'the guest duration reached the bar', async () => {
        const readout = await pane.locator('[data-testid="transport-time"]').textContent()
        const shown = parseClockText(String(readout).split('/')[1])
        assert.ok(shown !== null, `unparseable time readout ${JSON.stringify(readout)}`)
        assert.ok(
          Math.abs(shown - Math.floor(D)) <= 1,
          `the bar reads ${shown}s but the guest's <video> is ${D.toFixed(2)}s — the RPC duration is not reaching the transport`,
        )
        return `${String(readout).trim()} vs guest ${D.toFixed(2)}s`
      })

      await gate(
        'fullscreenSelector',
        'YouTube still has the button fullscreen drives',
        async () => {
          // `toggleFullscreen` shells out to `#movie_player .ytp-fullscreen-button`
          // (playerSingleton.ts:359-362). A spy on the host proves nothing about YouTube's
          // DOM; this asserts the one thing that actually rots — the selector. Whether the
          // guest then enters fullscreen is not asserted (see the report/ADR): an OOPIF
          // fullscreen transition under a bare X server is not a claim this can make.
          const present = await inGuest(
            `!!document.querySelector('#movie_player .ytp-fullscreen-button')`,
          )
          assert.equal(
            present,
            true,
            'no #movie_player .ytp-fullscreen-button in the guest — the fullscreen button is a no-op',
          )
          return '#movie_player .ytp-fullscreen-button resolves in the guest'
        },
      )

      await gate('transportPlayPause', 'the bar plays and pauses the guest', async () => {
        await pane.locator('button[aria-label="play"]').click()
        let played = null
        for (let i = 0; i < 20; i++) {
          await sleep(1000)
          played = await guestVideo()
          if (played && !played.paused && played.currentTime > 0) break
        }
        assert.ok(
          played && !played.paused && played.currentTime > 0,
          `the guest never started (last: ${JSON.stringify(played)})`,
        )
        // The label flip is the return leg: a guest `state` event has to reach the bar.
        const pauseBtn = pane.locator('button[aria-label="pause"]')
        await pauseBtn.waitFor({ timeout: 10000 })
        await pauseBtn.click()
        let stopped = null
        for (let i = 0; i < 10; i++) {
          await sleep(500)
          stopped = await guestVideo()
          if (stopped?.paused) break
        }
        assert.ok(stopped?.paused, `the guest never paused (last: ${JSON.stringify(stopped)})`)
        return `played to ${played.currentTime.toFixed(1)}s, label flipped to "pause", paused at ${stopped.currentTime.toFixed(1)}s`
      })

      // The capture PNG's non-blackness — a pre-existing soft observation, kept as one.
      // It is about capturePage, not the transport, and depends on network/DRM/consent.
      const sizeBytes = statSync(capturePath).size
      console.log(
        `thread-smoke: capture PNG file size = ${sizeBytes} bytes${sizeBytes < 1000 ? ' — suspiciously small, may be solid black (DRM or consent wall)' : ''}`,
      )

      await gate('scrubberClickSeeks', 'a track click seeks to where it was clicked', async () => {
        // THE gate. `fillPct`, tick placement and click→seek all hang off
        // `getBoundingClientRect().width`, which is 0 in happy-dom — TransportBar.tsx:123
        // then falls back to fraction 0, so every unit-level "seek" lands at 0:00 and the
        // existing test only proves a tick's own `t` is passed through. Nothing else in the
        // repo proves a track click resolves to the right second.
        const box = await track.boundingBox()
        assert.ok(box && box.width > 100, `the track is ${box?.width}px wide — no layout to click`)
        const targetX = box.x + box.width * SEEK_FRACTION
        const tickCentres = await win.evaluate(() =>
          Array.from(
            document.querySelectorAll(
              '[data-testid="player-pane"] [data-testid="scrubber-marker"]',
            ),
          ).map((b) => {
            const r = b.getBoundingClientRect()
            return r.left + r.width / 2
          }),
        )
        // A tick is an 8px-wide button that stops propagation; landing on one would seek to
        // ITS t and the gate would be measuring the wrong path.
        assert.ok(
          tickCentres.every((x) => Math.abs(x - targetX) > 8),
          `the target x is within 8px of a marker tick (${JSON.stringify(tickCentres.map(Math.round))}) — move SEEK_FRACTION`,
        )

        const target = SEEK_FRACTION * D
        const before = await guestVideo()
        assert.ok(
          Math.abs(before.currentTime - target) > D * 0.25,
          `the playhead is already at ${before.currentTime.toFixed(1)}s, within 25% of the ${target.toFixed(1)}s target — this click could not be observed`,
        )

        await track.click({ position: { x: box.width * SEEK_FRACTION, y: 2 } })
        // Tolerance beats a keyframe snap but is nowhere near the 0.62·D it would have to
        // swallow for the rect.width === 0 fallback (seek to 0) to pass.
        const tol = Math.max(2, D * 0.04)
        let after = null
        for (let i = 0; i < 20; i++) {
          await sleep(500)
          after = await guestVideo()
          if (after && Math.abs(after.currentTime - target) <= tol) break
        }
        assert.ok(
          after && Math.abs(after.currentTime - target) <= tol,
          `clicking at ${(SEEK_FRACTION * 100).toFixed(0)}% of the track left the guest at ${after?.currentTime?.toFixed(1)}s, not ~${target.toFixed(1)}s of ${D.toFixed(1)}s (±${tol.toFixed(1)}s)`,
        )

        // WHAT THIS GATE DELIBERATELY DOES NOT CLAIM: that the scrubber's FILL moved.
        //
        // It does not, and that is the app's behaviour rather than a measurement problem.
        // A seek made while PAUSED reaches the media element but emits nothing the host can
        // see: the guest listens for `seeked` and not `seeking` (`attachVideo`'s `mediaEvents`
        // list in `inject/youtube-guest.ts`), its `time` rAF loop only runs while playing
        // (`startRaf`, which bails on `v.paused`), and a far seek into an unbuffered region may
        // never complete at all in an unauthenticated session (the guest's `seekTo` handler and
        // its `allowSeekAhead` note, ADR 0017). Observed here: the guest sat at 61.9% of the
        // duration while the bar's fill read 0.1%.
        //
        // A resume-then-measure variant would make the fill observable, but the guest RPC
        // handshake is currently unreliable enough (see the precondition above) that it
        // could not be run green even once — and an assertion nobody has watched pass is
        // exactly what this milestone exists to stop shipping. `fillPct` therefore stays
        // ungated; the seek itself, which is the claim #169 is about, does not.
        return `clicked ${(SEEK_FRACTION * 100).toFixed(0)}% of ${box.width.toFixed(0)}px → guest at ${after.currentTime.toFixed(1)}s (target ${target.toFixed(1)}s ±${tol.toFixed(1)}s)`
      })

      await gate(
        'markerTicksPositioned',
        "the thread's anchors are ticks on the scrubber",
        async () => {
          const t = await win.evaluate(() => {
            const trk = document.querySelector(
              '[data-testid="player-pane"] [data-testid="scrubber-track"]',
            )
            const r = trk.getBoundingClientRect()
            return {
              left: r.left,
              width: r.width,
              ticks: Array.from(trk.querySelectorAll('[data-testid="scrubber-marker"]')).map(
                (b) => {
                  const br = b.getBoundingClientRect()
                  return { label: b.getAttribute('aria-label'), centre: br.left + br.width / 2 }
                },
              ),
            }
          })
          assert.ok(
            t.width > 100,
            `the track is ${t.width}px wide — tick positions are unmeasurable`,
          )
          assert.equal(
            t.ticks.length,
            UNIQUE_TS.length,
            `${t.ticks.length} ticks for ${ANCHOR_TS.length} anchored notes at ${UNIQUE_TS.length} distinct timestamps — markerPositions did not de-duplicate, or the cross-pane publish did not arrive`,
          )
          const seconds = t.ticks.map((k) =>
            parseClockText(String(k.label).replace(/^seek to /, '')),
          )
          assert.deepEqual(
            [...seconds].sort((a, b) => a - b),
            UNIQUE_TS,
            `the ticks are labelled ${JSON.stringify(seconds)}, not the seeded ${JSON.stringify(UNIQUE_TS)}`,
          )
          for (const [i, k] of t.ticks.entries()) {
            const want = t.left + (seconds[i] / D) * t.width
            assert.ok(
              Math.abs(k.centre - want) <= 2,
              `the t=${seconds[i]}s tick sits at x ${k.centre.toFixed(1)} but ${seconds[i]}/${D.toFixed(1)} of a ${t.width.toFixed(1)}px track is x ${want.toFixed(1)}`,
            )
          }
          return `${t.ticks.length} ticks at ${JSON.stringify(seconds)}s, each within 2px of (t/${D.toFixed(0)})·${t.width.toFixed(0)}px`
        },
      )

      await gate('rateSurvivesGuestReload', 'the rate lands in a RELOADED guest', async () => {
        // The subtle one. `load(id)` reassigns the webview `src` — a full guest reload that
        // destroys the <video> the guest's `setRate` handler wrote to — and `Player` has no
        // getPlaybackRate() to read the truth back, so the store is the only holder. PlayerPane
        // re-pushes on the next `state` event because that is the only public signal the NEW
        // port is live (its rate `useEffect`, keyed on `state`). A unit test can only simulate
        // the callback; where the re-push lands relative to the new document's handshake is
        // exactly what it cannot see.
        await speedBtn.click()
        await speedBtn.click()
        assert.equal((await speedBtn.textContent())?.trim(), '1.5×', 'the badge is not at 1.5×')
        let live = null
        for (let i = 0; i < 10; i++) {
          await sleep(500)
          live = await guestVideo()
          if (live?.rate === 1.5) break
        }
        assert.equal(
          live?.rate,
          1.5,
          `the CURRENT guest is at ${live?.rate}× — onRate never landed`,
        )

        // Leave the thread. ThreadView unmounts → useMarkerPublisher's cleanup fires, and
        // one thread's ticks must not survive onto the next video's scrubber.
        await win.locator('button[aria-label="back"]').click()
        await win.waitForFunction(
          () => document.querySelectorAll('[data-testid="scrubber-marker"]').length === 0,
          undefined,
          { timeout: 10000 },
        )
        assert.equal(
          await pane.count(),
          1,
          'the player pane closed with the thread — the marker-teardown claim above is vacuous and the reload below is not the one being tested',
        )

        // …and open the second video: a real `load()`, a real guest reload.
        await openThreadButton(win, VIDEO_ID_B, VIDEO_TITLE_B).click()
        await win.waitForFunction(
          (id) =>
            document
              .querySelector('#yt-player-wrapper webview')
              ?.getAttribute('src')
              ?.includes(id) === true,
          VIDEO_ID_B,
          { timeout: 20000 },
        )
        let reloaded = null
        for (let i = 0; i < 30; i++) {
          await sleep(2000)
          reloaded = await guestVideo()
          if (reloaded && reloaded.duration > 0 && reloaded.rate === 1.5) break
        }
        assert.ok(
          reloaded && reloaded.duration > 0,
          `the second video's guest never produced a <video> (last: ${JSON.stringify(reloaded)})`,
        )
        assert.ok(
          Math.abs(reloaded.duration - D) > 1,
          `the reloaded guest reports the same ${reloaded.duration}s duration as the first video — the src reassignment did not take, so nothing was reloaded`,
        )
        assert.equal(
          reloaded.rate,
          1.5,
          `the reloaded guest is playing at ${reloaded.rate}× while the badge reads ${(await speedBtn.textContent())?.trim()} — the re-push fired before the new port was live`,
        )
        assert.equal(
          (await speedBtn.textContent())?.trim(),
          '1.5×',
          'the badge lost the rate across the video change',
        )
        return `1× → 1.5× reached guest A, ticks cleared on unmount, and guest B (${reloaded.duration.toFixed(0)}s vs A's ${D.toFixed(0)}s) came up at 1.5×`
      })
    }
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  const line = (label, key) =>
    console.log(
      `  ${label.padEnd(26)} ${String(results[key]).padEnd(5)}${notes[key] ? ` — ${notes[key]}` : ''}`,
    )

  console.log('')
  console.log('thread-smoke RESULTS (player):')
  console.log(`  loopback origin:           ${results.loopbackOrigin}  (${origin})`)
  console.log(`  thread opened:             ${results.threadOpened}`)
  console.log(
    `  webview present:           ${results.webviewPresent}  (src=${webviewSrc ?? 'n/a'})`,
  )
  line('chrome hidden', 'chromeHidden')
  console.log(`  rect non-zero:             ${results.rectNonZero}`)
  console.log(`  capture PNG:               ${results.capturePng}`)
  console.log('')
  console.log('thread-smoke RESULTS (transport · B4 · #169) — CI-safe:')
  line('bar present', 'transportBarPresent')
  line('bar not covered', 'transportBarNotCovered')
  line('follow crosses panes', 'followCrossesPanes')
  line('rate badge cycles', 'rateBadgeCycles')
  console.log('')
  console.log(
    `thread-smoke RESULTS (#213 forced swap)${FORCE_SWAP ? '' : ' [set SMOKE_FORCE_SWAP=1]'}:`,
  )
  line('homepage committed 1st', 'forcedSwapCommitted')
  console.log('')
  console.log(
    `thread-smoke RESULTS (transport) — live guest${SMOKE_PLAYBACK ? '' : ' [set SMOKE_PLAYBACK=1]'}:`,
  )
  line('duration reaches bar', 'transportDuration')
  line('fullscreen selector', 'fullscreenSelector')
  line('play / pause', 'transportPlayPause')
  line('scrubber click seeks', 'scrubberClickSeeks')
  line('marker ticks positioned', 'markerTicksPositioned')
  line('rate survives reload', 'rateSurvivesGuestReload')
  console.log('')

  // Hard-fail if any CI-safe check did not PASS (WARN is tolerated for rect on headless).
  // The transport CI-safe gates join that set: they need no network and no guest, so a
  // failure there is a real regression, never an environment artefact. The live gates
  // fail the run too, but only when SMOKE_PLAYBACK asked for them AND the guest came up
  // (a consent wall marks them SKIP, above).
  const ciChecks = [
    results.loopbackOrigin,
    results.threadOpened,
    results.webviewPresent,
    results.capturePng,
    // chromeHidden joins the list explicitly: it used to be a bare `assert` that threw out
    // of the run, so it was already fatal in fact if not in this array. Recording it
    // instead of throwing must not quietly downgrade it.
    results.chromeHidden,
    results.transportBarPresent,
    results.transportBarNotCovered,
    results.followCrossesPanes,
    results.rateBadgeCycles,
  ]
  const liveChecks = [
    // The forced swap's premise belongs here rather than with the CI-safe set: like the six
    // below it is only ever asked for by a flag, and like them it is fatal the moment it is. A
    // run whose premise did not hold must not be able to exit 0 on six PASSes underneath it.
    results.forcedSwapCommitted,
    results.transportDuration,
    results.fullscreenSelector,
    results.transportPlayPause,
    results.scrubberClickSeeks,
    results.markerTicksPositioned,
    results.rateSurvivesGuestReload,
  ]
  const failed = Object.entries(results).filter(([, v]) => v === 'FAIL')
  if ([...ciChecks, ...liveChecks].some((r) => r === 'FAIL')) {
    throw new Error(
      `thread-smoke: ${failed.length} check(s) FAILED — ${failed.map(([k]) => k).join(', ')}`,
    )
  }
} finally {
  await app.close()
  rmSync(userDataDir, { recursive: true, force: true })
}
