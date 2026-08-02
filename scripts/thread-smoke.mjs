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
 * controls are suppressed in the guest (`yt/inject/youtube-guest.ts:121`, `v.controls =
 * false`), so for two milestones the docked player had no scrubber, speed badge, follow
 * toggle or fullscreen at all. v0.8.2 B1–B3 put them back. **Unit tests cannot show that
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
const SMOKE_PLAYBACK = process.env.SMOKE_PLAYBACK === '1'

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
    // `behavior: 'smooth'` (ThreadView.tsx:317) and overrides a single assignment made
    // while it is still animating.
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
    // 'up' pins the pill to the TOP of the column, 'down' to the bottom (ThreadView.tsx:800).
    // Reading it back positionally is the only way to see the direction at all.
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
      // A consent / sign-in wall redirects the guest before the first 'dom-ready', and
      // `onDomReady`'s `if (rpc) return` guard (playerSingleton.ts:175) means the runtime is
      // never re-injected into the watch page that follows — so the port is orphaned and no
      // event ever reaches the host. `insertCSS` re-fires on every dom-ready and is therefore
      // NOT evidence the RPC came up. This is the documented fresh-partition limitation
      // (header note + spec §11): dismiss the wall manually in `pnpm dev`, then re-run.
      const walled = !diag || diag.consent || !diag.hasVideo || !diag.href?.includes('/watch')
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
          skipGate(k, `${why} — consent/sign-in wall on the persist:yt-player partition`)
        }
      } else {
        // The guest is on the watch page with a healthy <video> and the host still knows
        // nothing: that is the MessagePort RPC itself, and it is a real failure, not an
        // environment artefact. Fail it rather than skipping, and skip only the dependants.
        await gate('transportDuration', 'the guest duration reached the bar', async () => {
          assert.fail(
            `${why} — the guest is on ${diag.href} with a <video>, so this is the MessagePort RPC (playerSingleton.ts:174-205), not a consent wall`,
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
        // see: the guest listens for `seeked` and not `seeking`
        // (`inject/youtube-guest.ts:131`), its `time` rAF loop only runs while playing
        // (`:100`), and a far seek into an unbuffered region may never complete at all in an
        // unauthenticated session (the `seekTo` note at `:193-197`, ADR 0017). Observed
        // here: the guest sat at 61.9% of the duration while the bar's fill read 0.1%.
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
        // The subtle one. `load(id)` reassigns the webview `src` (playerSingleton.ts:299-307)
        // — a full guest reload that destroys the <video> the guest's setRate handler wrote
        // to (inject/youtube-guest.ts:203) — and `Player` has no getPlaybackRate() to read
        // the truth back, so the store is the only holder. PlayerPane re-pushes on the next
        // `state` event because that is the only public signal the NEW port is live
        // (PlayerPane.tsx:119-121). A unit test can only simulate the callback; the ordering
        // inside onDomReady is exactly what it cannot see.
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
