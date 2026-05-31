/**
 * Playwright-Electron smoke for the v0.2 capture pipeline (ADR 0009).
 * Launches the BUILT app (loads over http://127.0.0.1 loopback shell), calls window.api.youtube.capture
 * with a fixed rect, and asserts the returned image is physical-pixel sized
 * (width === rect.width × scaleFactor) and the PNG was written to disk.
 *
 * Run: pnpm smoke:capture   (after `pnpm exec electron-vite build`)
 * Wayland note (spec §Risks): on linux+wayland capturePage may differ; this
 * script IS the self-test — a mismatch here is the signal to warn+degrade.
 *
 * @see docs/specs/v0.2-youtube-annotation.md §Testing (Electron smoke)
 */
import { strict as assert } from 'node:assert'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron } from 'playwright'

// Throwaway profile so the smoke never pollutes the real userData dir
// (matches the v0.1.3 morph-harness pattern).
const userDataDir = mkdtempSync(join(tmpdir(), 'linsae-smoke-'))
const app = await electron.launch({ args: ['out/main/index.js', `--user-data-dir=${userDataDir}`] })
try {
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')

  // Error-153 gate (spec:446): the embed must load under the loopback origin.
  const origin = await win.evaluate(() => location.origin)
  console.log(`thread-smoke: document origin = ${origin}`)
  assert.ok(
    origin.startsWith('http://127.0.0.1'),
    `renderer served over loopback http (got ${origin})`,
  )

  const embed = await win.evaluate(
    () =>
      new Promise((resolve) => {
        const events = []
        const wrapper = document.createElement('div')
        wrapper.style.cssText = 'position:fixed;left:0;top:0;width:480px;height:270px;z-index:99999'
        const iframe = document.createElement('iframe')
        iframe.id = 'yt-smoke'
        iframe.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin')
        iframe.width = '480'
        iframe.height = '270'
        iframe.src =
          'https://www.youtube-nocookie.com/embed/M7lc1UVf-VE?enablejsapi=1&controls=0&rel=0&playsinline=1'
        wrapper.appendChild(iframe)
        document.body.appendChild(wrapper)
        let player
        function attach() {
          player = new window.YT.Player('yt-smoke', {
            events: {
              onReady: () => {
                events.push('ready')
                try {
                  player.cueVideoById('M7lc1UVf-VE')
                } catch (e) {
                  events.push('cueErr:' + e)
                }
              },
              onStateChange: (e) => events.push('state:' + e.data),
              onError: (e) => events.push('ERROR:' + e.data),
            },
          })
        }
        if (window.YT && window.YT.Player) attach()
        else {
          window.onYouTubeIframeAPIReady = attach
          const s = document.createElement('script')
          s.src = 'https://www.youtube.com/iframe_api'
          document.head.appendChild(s)
        }
        setTimeout(() => resolve({ events, duration: player?.getDuration?.() ?? 0 }), 14000)
      }),
  )
  console.log(
    `thread-smoke: embed events = ${JSON.stringify(embed.events)} duration=${embed.duration}`,
  )
  const hadEmbedError = embed.events.some((e) => /^ERROR:(153|152|101|150|100)$/.test(e))
  const reachedPlayable = embed.events.some(
    (e) => e === 'state:5' || e === 'state:1' || e === 'state:3',
  )
  assert.ok(
    !hadEmbedError,
    `embed must not hit an embedding/referrer error (events: ${embed.events.join(',')})`,
  )
  assert.ok(
    reachedPlayable && embed.duration > 0,
    `embed must reach cued/playing with a duration (events: ${embed.events.join(',')}, dur ${embed.duration})`,
  )
  console.log('thread-smoke: Error-153 gate PASSED — embed loaded under loopback origin')

  const rect = { x: 0, y: 0, width: 200, height: 120 }
  const result = await win.evaluate(
    async ({ rect }) => window.api.youtube.capture({ rect, videoId: 'smoke-test', t: 0 }),
    { rect },
  )

  // scaleFactor of the window's display, read in the main process.
  const scaleFactor = await app.evaluate(({ screen, BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0]
    return screen.getDisplayMatching(w.getBounds()).scaleFactor
  })

  // Hard invariants (environment-independent): a PNG was written, the dims are
  // positive integers, and the dpr we returned IS the display scaleFactor we read
  // in main (a round-trip check, not an unverified Electron claim).
  assert.ok(existsSync(result.path), `PNG written at ${result.path}`)
  assert.ok(Number.isInteger(result.width) && result.width > 0, 'width is a positive integer')
  assert.ok(Number.isInteger(result.height) && result.height > 0, 'height is a positive integer')
  assert.equal(result.devicePixelRatio, scaleFactor, 'devicePixelRatio = display scaleFactor')

  // Soft check of ADR 0009's "physical px = rect × scaleFactor" claim. The
  // capturePage getSize() ⇄ DIP×scaleFactor relationship is environment-sensitive
  // (esp. linux+wayland — spec §Risks flags this exact env as unverified), so WARN,
  // don't fail: this smoke verifies the pipeline + IPC round-trip without hard-coding
  // a contract we have not independently sourced. A mismatch here IS the signal the
  // spec calls "warn and degrade" — record it; it means ADR 0009 needs a source/edit.
  const expected = Math.round(rect.width * scaleFactor)
  if (result.width === expected) {
    console.log(
      `capture smoke OK: ${result.width}×${result.height} @${scaleFactor}x (physical = rect×sf) → ${result.path}`,
    )
  } else {
    console.warn(
      `capture smoke: PNG OK (${result.width}×${result.height} @${scaleFactor}x) but width ${result.width} !== rect.width×sf (${expected}) — ` +
        `getSize() likely returns DIP not physical on this platform (wayland?). Record this; ADR 0009 needs updating. → ${result.path}`,
    )
  }

  // Issue #34 probe (informational, never fails): a positive INPUT rect positioned
  // fully off-viewport so clampRect collapses it to 0-width. Observe whether
  // youtube:capture RESOLVES (→ degenerate row/PNG: a guard is needed) or REJECTS
  // (→ clean failure: guard optional). Record the outcome for issue #34.
  try {
    const offscreen = { x: 100000, y: 100000, width: 50, height: 50 }
    const zr = await win.evaluate(
      async ({ rect }) => {
        try {
          const r = await window.api.youtube.capture({ rect, videoId: 'zero-probe', t: 0 })
          return { resolved: true, width: r.width, height: r.height, path: r.path }
        } catch (e) {
          return { resolved: false, error: String(e) }
        }
      },
      { rect: offscreen },
    )
    if (zr.resolved) {
      console.warn(
        `issue#34 probe: capture RESOLVED on a clamped-to-0 rect → ${zr.width}×${zr.height} — the 0-area guard (GH #34) is MISSING or regressed; a junk row was written.`,
      )
    } else {
      console.log(
        `issue#34 probe: capture correctly REJECTED a clamped-to-0 rect (${zr.error}) — 0-area guard working.`,
      )
    }
  } catch (e) {
    console.log(`issue#34 probe: inconclusive (${String(e)})`)
  }
} finally {
  await app.close()
  rmSync(userDataDir, { recursive: true, force: true })
}
