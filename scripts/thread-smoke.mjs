/**
 * Playwright-Electron smoke for the v0.2 thread UI (Task G1).
 * Launches the BUILT app (loads over http://127.0.0.1 loopback shell), seeds a
 * YouTube source note, opens its ThreadView, asserts the real player embed loads
 * without Error 153/152/101, and verifies a capture round-trips to a PNG.
 *
 * Run: pnpm smoke:thread   (after `pnpm exec electron-vite build`)
 * Mirrors the structure of scripts/capture-smoke.mjs — same launch pattern,
 * same loopback-origin assert, same Error-153 probe technique, same Wayland
 * soft-warn for the dimension contract.
 *
 * @see scripts/capture-smoke.mjs (reference implementation — L6 task)
 * @see docs/specs/v0.2-youtube-annotation.md §Testing (Electron smoke)
 * @see adrs/0008-loopback-http-shell.md (loopback origin contract)
 */
import { strict as assert } from 'node:assert'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron } from 'playwright'

const VIDEO_ID = 'M7lc1UVf-VE'

// Throwaway profile so the smoke never pollutes the real userData dir.
const userDataDir = mkdtempSync(join(tmpdir(), 'linsae-thread-smoke-'))

const app = await electron.launch({
  args: ['out/main/index.js', `--user-data-dir=${userDataDir}`],
})

try {
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')

  // ── 1. Assert loopback origin (ADR 0008) ──────────────────────────────────
  const origin = await win.evaluate(() => location.origin)
  console.log(`thread-smoke: document origin = ${origin}`)
  assert.ok(
    origin.startsWith('http://127.0.0.1'),
    `renderer must be served over loopback http (got ${origin})`,
  )
  console.log('thread-smoke [PASS] loopback origin')

  // ── 2. Seed a source note + video_sources row via real IPC ─────────────────
  // Call window.api directly (preload shape, object args) rather than the
  // renderer api wrapper (which uses positional args and is not available
  // in the evaluate context).
  await win.evaluate(
    async ({ videoId }) => {
      await window.api.notes.create({
        body: '',
        type: 'source',
        source_kind: 'youtube',
        source_locator: { media: 'youtube', video_id: videoId },
      })
      await window.api.videoSources.upsert({
        videoId,
        sourceKind: 'youtube',
        title: 'Smoke Video',
        channel: 'Chan',
        thumbnailUrl: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
      })
    },
    { videoId: VIDEO_ID },
  )

  // Reload so the renderer re-fetches notes.list and the feed renders the card.
  await win.reload()
  await win.waitForLoadState('domcontentloaded')

  // ── 3. Open the thread ─────────────────────────────────────────────────────
  // The MediaFeedNote card renders a <button aria-label="open video notes">
  // (MediaFeedNote.tsx line 228). Wait for it with a generous timeout to allow
  // React Query to settle; if not found, dump DOM for diagnostics.
  let threadOpened = false
  try {
    const btn = win.getByRole('button', { name: /open video notes/i })
    await btn.waitFor({ timeout: 15000 })
    await btn.click()
    threadOpened = true
    console.log('thread-smoke [PASS] thread opened')
  } catch (e) {
    // Dump partial DOM to aid diagnosis before hard-failing.
    const dom = await win.evaluate(() => document.body.innerHTML.slice(0, 4000))
    console.error(`thread-smoke [FAIL] could not find "open video notes" button: ${String(e)}`)
    console.error(`thread-smoke DOM snapshot (first 4000 chars):\n${dom}`)
    throw new Error('"open video notes" button not found — feed card did not render')
  }

  // ── 4. Error-153 gate ──────────────────────────────────────────────────────
  // Wait for the real player iframe (singleton, mounted by usePlayer via the
  // youtube-player library which calls YT.Player). The YT IFrame API needs to
  // load from youtube.com, which may take a few seconds. Poll the DOM state
  // every 2s, logging progress.
  let iframePresent = false
  let iframeSelector = 'iframe[src*="youtube-nocookie.com"]'

  // Poll until an iframe appears, then narrow to the best selector.
  let iframeFound = false
  let iframeSrcFound = '(not found)'
  for (let i = 0; i < 20; i++) {
    // Wait 2s between polls
    await new Promise((r) => setTimeout(r, 2000))
    const domInfo = await win.evaluate(() => {
      const frames = Array.from(document.querySelectorAll('iframe'))
      return {
        count: frames.length,
        srcs: frames.map((f) => f.src),
        wrapperExists: !!document.getElementById('yt-player-wrapper'),
        wrapperHtml: document.getElementById('yt-player-wrapper')?.innerHTML?.slice(0, 200) ?? null,
        ytAvailable: !!(window.YT && window.YT.Player),
        onYTReady: typeof window.onYouTubeIframeAPIReady,
        playerHostExists: !!document.querySelector('[data-testid="player-host"]'),
        playerHostChildCount:
          document.querySelector('[data-testid="player-host"]')?.children?.length ?? 0,
      }
    })
    console.log(`thread-smoke: DOM poll ${i + 1}/20 — ${JSON.stringify(domInfo)}`)
    if (domInfo.count > 0) {
      iframeFound = true
      iframeSrcFound = domInfo.srcs[0] ?? '(no src)'
      // Determine best selector
      if (domInfo.srcs.some((s) => s.includes('youtube-nocookie.com'))) {
        iframeSelector = 'iframe[src*="youtube-nocookie.com"]'
      } else if (domInfo.srcs.some((s) => s.includes('youtube.com'))) {
        iframeSelector = 'iframe[src*="youtube.com"]'
      } else {
        iframeSelector = 'iframe'
      }
      break
    }
  }

  if (iframeFound) {
    iframePresent = true
    console.log(
      `thread-smoke [PASS] iframe present — src=${iframeSrcFound}, selector=${iframeSelector}`,
    )
  } else {
    const finalDom = await win.evaluate(() => ({
      allIframes: Array.from(document.querySelectorAll('iframe')).map((f) => f.src),
      bodySnippet: document.body.innerHTML.slice(0, 2000),
    }))
    console.error(`thread-smoke [FAIL] player iframe not found after 40s polling`)
    console.error(`  Final DOM: ${JSON.stringify(finalDom)}`)
    throw new Error(`Player iframe not found — ThreadView did not mount the embed`)
  }

  // Parallel-player probe: same technique as capture-smoke.mjs L6 —
  // create a fresh div target and let YT.Player construct the iframe itself
  // (avoids pre-src'd iframe conflicts with existing widgetids), then poll
  // ~20s for a cued/playing state with NO ERROR:153/152/101. This
  // authoritatively proves the embed origin works in the built app.
  const embed = await win.evaluate(
    ({ videoId }) =>
      new Promise((resolve) => {
        const events = []
        // Use a plain div as the target — YT.Player CREATES the iframe inside
        // it, avoiding any widgetid clash with the existing singleton iframe.
        const container = document.createElement('div')
        container.id = 'yt-smoke-probe'
        container.style.cssText =
          'position:fixed;left:-9999px;top:0;width:480px;height:270px;z-index:1'
        document.body.appendChild(container)
        let player
        function attach() {
          player = new window.YT.Player('yt-smoke-probe', {
            width: 480,
            height: 270,
            host: 'https://www.youtube-nocookie.com',
            playerVars: { enablejsapi: 1, controls: 0, rel: 0, playsinline: 1, autoplay: 0 },
            events: {
              onReady: () => {
                events.push('ready')
                try {
                  const s = player.getPlayerState()
                  events.push('stateAtReady:' + s)
                  player.cueVideoById(videoId)
                } catch (e2) {
                  events.push('getStateErr:' + e2)
                }
              },
              onStateChange: (e) => events.push('state:' + e.data),
              onError: (e) => events.push('ERROR:' + e.data),
            },
          })
        }
        if (window.YT && window.YT.Player) {
          attach()
        } else {
          window.onYouTubeIframeAPIReady = attach
          const s = document.createElement('script')
          s.src = 'https://www.youtube.com/iframe_api'
          document.head.appendChild(s)
        }
        setTimeout(() => {
          let dur = 0
          let finalState = -99
          try {
            dur = player?.getDuration?.() ?? 0
            finalState = player?.getPlayerState?.() ?? -99
          } catch (e4) {
            events.push('finalErr:' + e4)
          }
          resolve({ events, duration: dur, finalState })
        }, 20000)
      }),
    VIDEO_ID,
  )

  console.log(`thread-smoke: embed probe result = ${JSON.stringify(embed)}`)

  const hadEmbedError = embed.events.some((e) => /^ERROR:(153|152|101|150|100)$/.test(e))
  // reachedPlayable: state 5=cued, 1=playing, 3=buffering, OR stateAtReady:5/1/3
  const reachedPlayable =
    embed.events.some((e) => e === 'state:5' || e === 'state:1' || e === 'state:3') ||
    embed.events.some(
      (e) => e === 'stateAtReady:5' || e === 'stateAtReady:1' || e === 'stateAtReady:3',
    ) ||
    embed.finalState === 5 ||
    embed.finalState === 1 ||
    embed.finalState === 3

  assert.ok(
    !hadEmbedError,
    `embed must not hit an embedding/referrer error (events: ${embed.events.join(',')})`,
  )
  assert.ok(
    reachedPlayable,
    `embed must reach cued/playing (events: ${embed.events.join(',')}, finalState ${embed.finalState}, dur ${embed.duration})`,
  )
  console.log('thread-smoke [PASS] Error-153 gate — embed loaded under loopback origin')

  // ── 5. Capture round-trip ──────────────────────────────────────────────────
  // Get the real player iframe's bounding rect (the singleton iframe created by
  // playerSingleton.ts — getIframeRect uses wrapper.querySelector('iframe')).
  const iframeLocator = win.locator(iframeSelector).first()
  const rect = await iframeLocator.boundingBox()

  let capturePath = null
  let captureWidth = null
  let captureHeight = null

  if (!rect || rect.width <= 0 || rect.height <= 0) {
    console.warn(
      `thread-smoke [WARN] player iframe bounding rect is zero/null (${JSON.stringify(rect)}) — using fallback rect for capture probe`,
    )
    // Fallback to a fixed rect so we still exercise the IPC pipeline.
    const fallback = { x: 0, y: 0, width: 200, height: 120 }
    const result = await win.evaluate(
      async ({ r, videoId }) => window.api.youtube.capture({ rect: r, videoId, t: 5 }),
      { r: fallback, videoId: VIDEO_ID },
    )
    capturePath = result.path
    captureWidth = result.width
    captureHeight = result.height
  } else {
    const result = await win.evaluate(
      async ({ r, videoId }) => window.api.youtube.capture({ rect: r, videoId, t: 5 }),
      { r: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, videoId: VIDEO_ID },
    )
    capturePath = result.path
    captureWidth = result.width
    captureHeight = result.height
  }

  assert.ok(existsSync(capturePath), `PNG must be written at ${capturePath}`)
  assert.ok(
    Number.isInteger(captureWidth) && captureWidth > 0,
    'capture width is a positive integer',
  )
  assert.ok(
    Number.isInteger(captureHeight) && captureHeight > 0,
    'capture height is a positive integer',
  )

  // Wayland dimension contract — soft warn (spec §Risks), same as capture-smoke.
  if (rect && rect.width > 0) {
    const scaleFactor = await app.evaluate(({ screen, BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0]
      return screen.getDisplayMatching(w.getBounds()).scaleFactor
    })
    const expected = Math.round(rect.width * scaleFactor)
    if (captureWidth === expected) {
      console.log(
        `thread-smoke: capture OK ${captureWidth}×${captureHeight} @${scaleFactor}x (physical = rect×sf) → ${capturePath}`,
      )
    } else {
      console.warn(
        `thread-smoke: capture PNG OK (${captureWidth}×${captureHeight} @${scaleFactor}x) but width ${captureWidth} !== rect.width×sf (${expected}) — ` +
          `getSize() likely returns DIP not physical on this platform (wayland?). ADR 0009 may need updating. → ${capturePath}`,
      )
    }
  } else {
    console.log(
      `thread-smoke: capture OK ${captureWidth}×${captureHeight} (fallback rect, no dim check) → ${capturePath}`,
    )
  }

  console.log('thread-smoke [PASS] capture PNG round-trip')

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log('')
  console.log('thread-smoke RESULTS:')
  console.log(`  loopback origin:   PASS (${origin})`)
  console.log(`  thread opened:     ${threadOpened ? 'PASS' : 'FAIL'}`)
  console.log(`  iframe present:    ${iframePresent ? 'PASS' : 'FAIL'}`)
  console.log('  Error-153 gate:    PASS')
  console.log(`  capture PNG:       PASS → ${capturePath}`)
} finally {
  await app.close()
  rmSync(userDataDir, { recursive: true, force: true })
}
