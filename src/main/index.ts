/**
 * Main-process bootstrap for linsae.
 *
 * Boot order (must not be reshuffled):
 *  1. Acquire the single-instance lock BEFORE any other init — losing the
 *     lock means we exit immediately, so we must not have created any
 *     windows, opened the DB, or registered IPC handlers.
 *  2. `app.whenReady()` → resolve `userData`, mkdir notes + logs + attachments.
 *  3. Open the SQLite DB and run migrations (schema is the precondition for
 *     the reconciler).
 *  4. Run the startup reconciler (file system → DB).
 *  5. Register IPC handlers (renderer must never see an empty IPC surface).
 *  6. Start the loopback HTTP shell (BEFORE loadURL — otherwise the renderer's
 *     first GET races to ECONNREFUSED).
 *  7. Build the application menu, then create the renderer window.
 *
 * Why this order: every step depends on the one before it. Creating the
 * window before IPC is registered would race the renderer's first calls;
 * running the reconciler before migrations would query a non-existent schema;
 * the loopback shell must be listening before loadURL is called.
 *
 * @see docs/specs/v0.1-rolling-feed-and-search.md §Storage architecture
 * @see docs/specs/v0.1-rolling-feed-and-search.md §Electron security baseline
 * @see docs/plans/v0.1-rolling-feed-and-search.md §Task 21
 * @see docs/specs/v0.2-localhost-shell.md §7 B3
 */

import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { app, BrowserWindow, Menu, screen, shell } from 'electron'
import { openDb } from './db/client'
import { runMigrations } from './db/migrate'
import { reconcile } from './db/reconcile'
import { NotesDir } from './files/notes-dir'
import { DEV_MEDIA_PORT, startLoopbackShell } from './http-shell'
import { registerAllIpc } from './ipc'
import { secureWebPreferences } from './security'

// Why: single-instance lock must precede everything. A second launch should
// focus the running window and exit, NOT race the first instance on the DB.
// `process.exit(0)` is intentional — `app.quit()` is async, and we must not
// fall through to the rest of this file (which would open a second DB handle
// and register duplicate IPC channels).
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
  process.exit(0)
}

let mainWindow: BrowserWindow | null = null

// Boot timeline origin, set when app.whenReady() fires. Logged at each serial
// boot step + at the renderer's first paint (ready-to-show) so the dev console
// shows where startup time goes. ready-to-show now fires on the #boot-splash's
// first paint (fast) rather than after React mounts — the delta makes that
// improvement visible. @see src/renderer/index.html (#boot-splash)
let bootStart = 0
const bootMark = (label: string) =>
  console.log(`[boot] ${label} +${Math.round(performance.now() - bootStart)}ms`)

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }
})

/**
 * Creates the renderer `BrowserWindow` with the hardened web preferences
 * from {@link secureWebPreferences} and loads either the dev server URL or
 * the loopback shell origin.
 *
 * Why `show: false` + `ready-to-show`: avoids the white-flash on first
 * paint; the window only appears once the renderer has its initial frame.
 *
 * Why `setWindowOpenHandler` denies and shells out: links inside the
 * renderer should open in the user's browser, not in a second Electron
 * window (which would inherit the renderer's privileges).
 *
 * @param origin - The loopback shell origin (`http://127.0.0.1:<port>`).
 *   Used as the document URL in prod; ignored in dev (ELECTRON_RENDERER_URL
 *   takes precedence). The loopback shell must already be listening before
 *   this is called.
 * @returns The newly created `BrowserWindow`.
 * @see https://www.electronjs.org/docs/latest/api/browser-window
 * @see src/main/http-shell.ts (startLoopbackShell)
 */
function createWindow(origin: string): BrowserWindow {
  // Open on whatever monitor the cursor is on, not the primary display.
  // Electron can't know which terminal launched it, but the cursor is a reliable
  // proxy for "the screen I'm working on". Without an explicit x/y the window
  // centers on the primary display regardless of launch context.
  // @see https://www.electronjs.org/docs/latest/api/screen
  const width = 1280
  const height = 800
  const cursorDisplay = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const area = cursorDisplay.workArea
  const x = Math.round(area.x + (area.width - width) / 2)
  const y = Math.round(area.y + (area.height - height) / 2)
  const win = new BrowserWindow({
    width,
    height,
    x,
    y,
    minWidth: 720,
    minHeight: 400,
    show: false,
    // frame: false removes the OS title bar entirely; the renderer provides a
    // custom drag region + min/max/close cluster in WindowFrame.tsx. With a
    // frameless window there is no menu bar slot for Electron to render, so
    // we set only the role-only Menu (editMenu/viewMenu/windowMenu) below so
    // standard keyboard accelerators (Cmd+R, Cmd+Alt+I, Cmd+C/V/X, etc.)
    // still fire — Alt does NOT surface a menu with frame:false, so
    // autoHideMenuBar would be a no-op and is omitted.
    frame: false,
    title: '',
    // Match the #boot-splash / app canvas so the window's pre-paint frame isn't
    // a white flash when we show it before ready-to-show (the dev cap below).
    backgroundColor: '#FFFFFF',
    webPreferences: secureWebPreferences(join(__dirname, '../preload/index.js')),
  })
  win.on('ready-to-show', () => {
    bootMark('renderer first paint (ready-to-show)')
    win.show()
  })
  win.webContents.once('dom-ready', () => bootMark('renderer dom-ready'))
  win.webContents.once('did-finish-load', () => bootMark('renderer did-finish-load'))
  // Dev: ready-to-show lags seconds behind the static #boot-splash's first paint
  // while Vite compiles the renderer module graph on a cold start (~4.2s here vs
  // ~67ms of main-process boot). Gating win.show() on ready-to-show therefore
  // keeps the splash painting into an invisible window. Show after a short cap so
  // the splash is visible during the compile; backgroundColor above keeps any
  // pre-splash frame from flashing white. In prod ready-to-show fires fast, so
  // we keep the clean ready-to-show path and skip the cap entirely.
  if (process.env.ELECTRON_RENDERER_URL) {
    setTimeout(() => {
      if (!win.isDestroyed() && !win.isVisible()) {
        bootMark('show (dev splash cap, pre-ready-to-show)')
        win.show()
      }
    }, 500)
  }
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadURL(`${origin}/`)
  }
  return win
}

app.whenReady().then(async () => {
  bootStart = performance.now()
  const userData = app.getPath('userData')
  const notesDir = join(userData, 'notes')
  const logsDir = join(userData, 'logs')
  const attachmentsDir = join(userData, 'attachments')
  const dbPath = join(userData, 'linsae.db')
  // notesDir is created by NotesDir's constructor below; logsDir and attachmentsDir
  // need explicit mkdir (attachmentsDir is also pre-created so IPC never races the fs).
  if (!existsSync(logsDir)) mkdirSync(logsDir, { recursive: true })
  if (!existsSync(attachmentsDir)) mkdirSync(attachmentsDir, { recursive: true })

  const db = openDb(dbPath)
  bootMark('db open')
  runMigrations(db)
  bootMark('migrations')
  const nd = new NotesDir(notesDir)
  const report = reconcile(db, nd, logsDir)
  // Surfaces the reconciler bucket counts on every launch; renderer reads
  // `report.skipped` via `system:getReconcileSkipped` to drive the banner.
  console.log(`reconciled: ${JSON.stringify(report)}`)
  bootMark(`reconcile (${report.scanned} notes)`)

  registerAllIpc(db, nd, notesDir, logsDir, report.skipped, attachmentsDir)

  // Start the loopback HTTP shell BEFORE createWindow/loadURL so the server
  // is listening before the renderer's first GET. In dev (ELECTRON_RENDERER_URL
  // set) we start on the fixed DEV_MEDIA_PORT so the Vite proxy can reach it;
  // in prod we use an ephemeral port (listen(0)) and pass the origin to loadURL.
  // exactOptionalPropertyTypes: omit the key entirely rather than set port:undefined.
  // @see docs/specs/v0.2-localhost-shell.md §7 B3
  const shellBaseOpts = { rendererDir: join(__dirname, '../renderer'), attachmentsDir }
  const isDev = Boolean(process.env.ELECTRON_RENDERER_URL)
  // In dev the renderer loads via ELECTRON_RENDERER_URL so only /_media/ is
  // routed through the shell.  If DEV_MEDIA_PORT is already in use (e.g. a
  // previous dev run still listening) we log and continue — /_media/ will 404
  // but the app is otherwise functional.  In prod the shell serves the whole
  // document origin so a failure there must still propagate (let it reject).
  let shell: Awaited<ReturnType<typeof startLoopbackShell>>
  if (isDev) {
    try {
      shell = await startLoopbackShell({ ...shellBaseOpts, port: DEV_MEDIA_PORT })
    } catch (err) {
      console.error('http-shell: dev shell failed to start (/_media/ will 404):', err)
      // Fabricate a no-op shell handle so the rest of boot doesn't branch.
      shell = { origin: `http://127.0.0.1:${DEV_MEDIA_PORT}`, close: () => Promise.resolve() }
    }
  } else {
    shell = await startLoopbackShell(shellBaseOpts)
  }
  app.on('will-quit', () => {
    void shell.close()
  })
  bootMark('http-shell listening')

  // Role-only menu: no visible bar (frame:false has no menu slot), but the
  // editMenu / viewMenu / windowMenu roles register the standard keyboard
  // accelerators (cut/copy/paste, reload, devtools, minimize/zoom). The
  // earlier File submenu (reveal notes, open logs, quit) was removed —
  // reveal-notes is in WindowFrame, quit is the close button / OS shortcut,
  // open-logs is reachable via the reconcile-skip banner today and can move
  // to the command palette later if it needs a dedicated entry.
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([{ role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' }]),
  )
  mainWindow = createWindow(shell.origin)
  // Reuse the same shell when macOS re-activates the app with no windows open.
  // Do NOT restart the shell — it's already bound and listening.
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow(shell.origin)
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// Full webview security guard (ADR 0016): clamp guest webPreferences, reject
// non-YouTube attaches, confine guest navigation, and deny all popups.
// Why here (not in createWindow): web-contents-created fires for ALL windows
// and guest webviews alike, so this is the correct attachment point per the
// Electron security docs.
// @see https://www.electronjs.org/docs/latest/tutorial/security#12-verify-webview-options-before-creation
// Hostname-suffix allowlist for guest navigation. Anchored to the END of the
// hostname so `evil-youtube.com.attacker.net` is rejected (a bare substring match
// would let it through). Includes the Google sign-in/consent domains so the manual
// consent / login flow (spec §8 — not automated) can complete inside the webview.
const GUEST_HOST_ALLOW =
  /(?:^|\.)(?:youtube\.com|youtube-nocookie\.com|youtu\.be|google\.com|googleapis\.com|gstatic\.com|ggpht\.com|googleusercontent\.com)$/

app.on('web-contents-created', (_e, contents) => {
  contents.on('will-attach-webview', (event, prefs, params) => {
    delete prefs.preload
    prefs.nodeIntegration = false
    prefs.contextIsolation = true
    prefs.sandbox = true
    // The player webview is created src-less and navigated via load() afterwards,
    // so an empty src at attach time is legitimate — only block a NON-empty src
    // that isn't YouTube. Runtime navigation is confined by will-navigate below.
    const src = params.src ?? ''
    if (src && !/^https:\/\/(www\.)?youtube\.com\//.test(src)) event.preventDefault()
  })
  if (contents.getType() === 'webview') {
    contents.on('will-navigate', (event, url) => {
      let host = ''
      try {
        host = new URL(url).hostname
      } catch {
        event.preventDefault()
        return
      }
      if (!GUEST_HOST_ALLOW.test(host)) event.preventDefault()
    })
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  }
})
