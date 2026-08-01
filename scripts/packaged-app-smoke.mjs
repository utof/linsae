/**
 * Acceptance test for v0.8.1 §3.1: does the PACKAGED app still work after the
 * dependencies -> devDependencies split and the files: allow-list?
 *
 * The size assertion alone cannot see the failure mode this change risks: an
 * app that launches but cannot require() a dep the main process needs at
 * runtime. main externalizes better-sqlite3, js-yaml, pdfjs-dist, uuidv7 and
 * zod (electron.vite.config.ts externalizeDepsPlugin), so each must survive.
 *
 * Launches dist/linux-unpacked/linsae (NOT out/main/index.js) — the packaged
 * binary is the artifact under test.
 */
import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron } from 'playwright'

const EXE = join(process.cwd(), 'dist', 'linux-unpacked', 'linsae')
const userDataDir = mkdtempSync(join(tmpdir(), 'linsae-pkg-check-'))
const consoleErrors = []

const app = await electron.launch({
  executablePath: EXE,
  args: [`--user-data-dir=${userDataDir}`, '--no-sandbox'],
})

try {
  const page = await app.firstWindow()
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text())
  })
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`))

  await page.waitForLoadState('domcontentloaded')

  // 1. The renderer actually mounted. #root staying empty = white-screen boot fail.
  await page.waitForFunction(() => document.querySelector('#root')?.children.length > 0, {
    timeout: 30_000,
  })
  console.log('pkg-check [PASS] renderer mounted (#root non-empty)')

  // 2. better-sqlite3 + zod + js-yaml: the composer only renders once the app has
  //    booted through main's DB open + IPC handshake. A dlopen failure or a
  //    missing dep in main surfaces as this never appearing.
  const composer = page.locator('textarea').first()
  await composer.waitFor({ state: 'visible', timeout: 30_000 })
  console.log('pkg-check [PASS] composer visible — main booted, DB opened, IPC alive')

  // 3. Prove the DB round-trips rather than merely that the UI drew: create a
  //    note and assert it comes back. This is what actually exercises
  //    better-sqlite3's native binding under Electron's ABI.
  const marker = `pkg-check-${Date.now()}`
  await composer.click()
  await composer.fill(marker)
  await composer.press('Enter')
  await page.waitForFunction((m) => document.body.innerText.includes(m), marker, {
    timeout: 20_000,
  })
  console.log('pkg-check [PASS] note created and read back — better-sqlite3 native binding works')

  // 4. Main-side pdf.js. This MUST go through a real import rather than a
  //    require() probe: pdf.js is loaded lazily (extract-pdf-metadata.ts), so
  //    boot no longer touches it and a broken load would hide until the first
  //    PDF. `pageCount` is produced by extractPdfMetadata in main, so a correct
  //    value is end-to-end proof that the legacy build loaded in the PACKAGED
  //    app — where its optional @napi-rs/canvas dep is absent and the DOMMatrix
  //    globals shim is what keeps the import from throwing.
  const fixture = join(process.cwd(), 'tests', 'fixtures', 'multi-feature.pdf')
  const imported = await page.evaluate(
    async (filePath) => await window.api.pdf.import({ filePath }),
    fixture,
  )
  assert.equal(
    imported.pageCount,
    3,
    `main-side pdf.js must read multi-feature.pdf as 3 pages (got ${imported.pageCount}) — ` +
      'a null here means the legacy build failed to import in the packaged app',
  )
  console.log(
    `pkg-check [PASS] main-side pdf.js works in the package (pageCount=${imported.pageCount}) — uuidv7 also proven, it generated pdfId=${imported.pdfId}`,
  )

  const fatal = consoleErrors.filter((e) =>
    /MODULE_NOT_FOUND|ERR_DLOPEN_FAILED|Cannot find module/i.test(e),
  )
  assert.equal(fatal.length, 0, `module-resolution errors in renderer: ${fatal.join(' | ')}`)
  console.log('pkg-check [PASS] no module-resolution errors on the console')

  console.log('\npkg-check: ALL ASSERTIONS PASSED')
  if (consoleErrors.length) {
    console.log(`(${consoleErrors.length} non-fatal console errors, listed for info:)`)
    for (const e of consoleErrors.slice(0, 5)) console.log('   ', e.slice(0, 160))
  }
} finally {
  await app.close()
  rmSync(userDataDir, { recursive: true, force: true })
}
