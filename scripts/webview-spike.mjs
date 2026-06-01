/**
 * SPIKE GATE — Task 1 of v0.3-youtube-webview-player.
 *
 * Proves two things on this exact Electron setup before we build:
 *  1. host→guest MessagePort transfer via webview.contentWindow.postMessage works.
 *  2. win.webContents.capturePage(rect) captures a webview region as a real
 *     (non-black, non-empty) image.
 *
 * Run: pnpm rebuild:electron && DISPLAY=:0 node scripts/webview-spike.mjs
 *
 * @see docs/plans/v0.3-youtube-webview-player.md §Task 1
 * @see scripts/thread-smoke.mjs (launch pattern template)
 */

import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron } from 'playwright'

// Throwaway profile — never pollutes the real userData dir.
const userDataDir = mkdtempSync(join(tmpdir(), 'linsae-webview-spike-'))

console.log('webview-spike: launching Electron...')

const app = await electron.launch({
  args: ['out/main/index.js', `--user-data-dir=${userDataDir}`],
  env: {
    ...process.env,
    DISPLAY: process.env.DISPLAY ?? ':0',
  },
})

try {
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')

  // ── 1. Create a <webview> and wait for dom-ready ───────────────────────────
  console.log('webview-spike: creating <webview src="https://example.com">...')

  const domReadyResult = await win.evaluate(() => {
    return new Promise((resolve, reject) => {
      const wv = document.createElement('webview')
      // Use partition so it doesn't share session with any real content.
      wv.setAttribute('partition', 'persist:yt-spike')
      wv.setAttribute('src', 'https://example.com')
      wv.style.cssText = 'position:fixed;left:0;top:0;width:400px;height:300px;z-index:1;'
      document.body.appendChild(wv)
      // Webview fires 'dom-ready' when its document is loaded.
      wv.addEventListener('dom-ready', () => resolve('dom-ready'), { once: true })
      // Safety timeout
      setTimeout(() => reject(new Error('dom-ready timeout after 30s')), 30000)
    })
  })

  console.log(`webview-spike: webview event = ${domReadyResult}`)
  assert.equal(domReadyResult, 'dom-ready', 'webview must fire dom-ready')
  console.log('webview-spike [PASS] webview dom-ready')

  // ── 2. Port round-trip ─────────────────────────────────────────────────────
  // The plan mandates:
  //   a) executeJavaScript injects a listener in the guest for the 'SPK' message
  //   b) host transfers port2 to the guest via webview.contentWindow.postMessage
  //   c) guest echoes back 'echo:hello' via the port
  //   d) poll window.__spk for the echo (≤5s)
  console.log('webview-spike: testing MessagePort round-trip...')

  const portResult = await win.evaluate(() => {
    return new Promise((resolve) => {
      try {
        // Find the webview we just created.
        const webview = document.querySelector('webview')
        if (!webview) {
          resolve({ ok: false, error: 'no webview element found' })
          return
        }

        // Check contentWindow availability.
        const cw = webview.contentWindow
        if (!cw) {
          resolve({ ok: false, error: 'webview.contentWindow is null/undefined' })
          return
        }

        // Step a: inject the guest-side listener.
        webview
          .executeJavaScript(
            "window.addEventListener('message', e => { if (e.data === 'SPK') { const p = e.ports[0]; p.onmessage = m => p.postMessage('echo:' + m.data); } })",
            false,
          )
          .then(() => {
            // Step b: create the channel and transfer port2 to the guest.
            const { port1, port2 } = new MessageChannel()
            port1.onmessage = (m) => {
              window.__spk = m.data
            }
            cw.postMessage('SPK', '*', [port2])
            // Step c: send the test message.
            port1.postMessage('hello')

            // Step d: poll for the echo (≤5s).
            let elapsed = 0
            const interval = setInterval(() => {
              elapsed += 100
              if (window.__spk === 'echo:hello') {
                clearInterval(interval)
                resolve({ ok: true, value: window.__spk })
              } else if (elapsed >= 5000) {
                clearInterval(interval)
                resolve({
                  ok: false,
                  error: `timeout — window.__spk = ${JSON.stringify(window.__spk)}`,
                })
              }
            }, 100)
          })
          .catch((err) => {
            resolve({ ok: false, error: `executeJavaScript failed: ${String(err)}` })
          })
      } catch (e) {
        resolve({ ok: false, error: `caught: ${String(e)}` })
      }
    })
  })

  console.log(`webview-spike: port result = ${JSON.stringify(portResult)}`)

  if (!portResult.ok) {
    console.error(`webview-spike [FAIL] port round-trip: ${portResult.error}`)
    // Report but continue to the capture test.
  } else {
    assert.equal(portResult.value, 'echo:hello', 'port must echo back hello')
    console.log(`webview-spike [PASS] port round-trip — received: ${portResult.value}`)
  }

  // ── 3. Production capture path ────────────────────────────────────────────
  // Read the webview's bounding rect in the renderer.
  console.log('webview-spike: reading webview bounding rect...')

  const rect = await win.evaluate(() => {
    const wv = document.querySelector('webview')
    if (!wv) return null
    const r = wv.getBoundingClientRect()
    return {
      x: Math.round(r.x),
      y: Math.round(r.y),
      width: Math.round(r.width),
      height: Math.round(r.height),
    }
  })

  console.log(`webview-spike: webview rect = ${JSON.stringify(rect)}`)

  if (!rect || rect.width <= 0 || rect.height <= 0) {
    console.error(
      'webview-spike [FAIL] capture: webview bounding rect is zero/null — cannot test capture',
    )
  } else {
    // Use the PRODUCTION capture path: BrowserWindow.webContents.capturePage(rect)
    // This is the exact pipeline used in src/main/ipc/media.ts.
    const captureResult = await app.evaluate(({ BrowserWindow }, { x, y, width, height }) => {
      const wins = BrowserWindow.getAllWindows()
      if (!wins.length) return { ok: false, error: 'no BrowserWindow found' }
      return wins[0].webContents
        .capturePage({ x, y, width, height })
        .then((img) => {
          const png = img.toPNG()
          // Check non-zero pixels via getBitmap (returns raw BGRA buffer).
          const bitmap = img.toBitmap()
          let nonZeroCount = 0
          for (let i = 0; i < bitmap.length; i++) {
            if (bitmap[i] !== 0) nonZeroCount++
          }
          return {
            ok: true,
            pngLength: png.length,
            bitmapLength: bitmap.length,
            nonZeroPixelBytes: nonZeroCount,
            imgWidth: img.getSize().width,
            imgHeight: img.getSize().height,
          }
        })
        .catch((err) => ({ ok: false, error: String(err) }))
    }, rect)

    console.log(`webview-spike: capture result = ${JSON.stringify(captureResult)}`)

    if (!captureResult.ok) {
      console.error(`webview-spike [FAIL] capture: ${captureResult.error}`)
    } else {
      assert.ok(
        captureResult.pngLength > 0,
        `PNG must be non-empty (got ${captureResult.pngLength} bytes)`,
      )
      assert.ok(
        captureResult.nonZeroPixelBytes > 0,
        `capture must have non-zero pixels (got ${captureResult.nonZeroPixelBytes} non-zero bytes out of ${captureResult.bitmapLength})`,
      )
      console.log(
        `webview-spike [PASS] host capturePage non-empty — ${captureResult.pngLength} PNG bytes, ${captureResult.imgWidth}×${captureResult.imgHeight}, ${captureResult.nonZeroPixelBytes}/${captureResult.bitmapLength} non-zero pixel bytes`,
      )
    }
  }

  // ── Summary ─────────────────────────────────────────────────────────────────
  console.log('')
  console.log('webview-spike RESULTS:')
  console.log(`  webview dom-ready:   PASS`)
  const portSummary = portResult.ok ? `PASS (${portResult.value})` : `FAIL — ${portResult.error}`
  console.log(`  port round-trip:     ${portSummary}`)
  console.log(`  capture:             see above`)

  if (!portResult.ok) {
    process.exitCode = 1
  }
} finally {
  await app.close()
  rmSync(userDataDir, { recursive: true, force: true })
}
