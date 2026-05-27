/**
 * Main-process bootstrap for linsae.
 *
 * Boot order (must not be reshuffled):
 *  1. Acquire the single-instance lock BEFORE any other init — losing the
 *     lock means we exit immediately, so we must not have created any
 *     windows, opened the DB, or registered IPC handlers.
 *  2. `app.whenReady()` → resolve `userData`, mkdir notes + logs.
 *  3. Open the SQLite DB and run migrations (schema is the precondition for
 *     the reconciler).
 *  4. Run the startup reconciler (file system → DB).
 *  5. Register IPC handlers (renderer must never see an empty IPC surface).
 *  6. Build the application menu, then create the renderer window.
 *
 * Why this order: every step depends on the one before it. Creating the
 * window before IPC is registered would race the renderer's first calls;
 * running the reconciler before migrations would query a non-existent schema.
 *
 * @see docs/specs/v0.1-rolling-feed-and-search.md §Storage architecture
 * @see docs/specs/v0.1-rolling-feed-and-search.md §Electron security baseline
 * @see docs/plans/v0.1-rolling-feed-and-search.md §Task 21
 */

import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow, Menu, shell } from 'electron'
import { openDb } from './db/client'
import { runMigrations } from './db/migrate'
import { reconcile } from './db/reconcile'
import { NotesDir } from './files/notes-dir'
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

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }
})

/**
 * Installs the application menu with the v0.1 File submenu (reveal notes,
 * open logs, quit) plus the standard edit/view/window roles.
 *
 * Why a menu (not just the in-app `≡` button): macOS users expect a native
 * menu bar; on Linux/Windows the menu is the fallback if the renderer fails
 * to mount. Both entry points eventually call `shell.openPath`, so the user
 * always has a way to find their on-disk notes.
 *
 * @param notesDir - Absolute path of the notes directory.
 * @param logsDir - Absolute path of the logs directory.
 * @see docs/specs/v0.1-rolling-feed-and-search.md §Reveal notes folder
 */
function buildMenu(notesDir: string, logsDir: string): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'File',
      submenu: [
        { label: 'Reveal notes folder', click: () => shell.openPath(notesDir) },
        { label: 'Open logs folder', click: () => shell.openPath(logsDir) },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

/**
 * Creates the renderer `BrowserWindow` with the hardened web preferences
 * from {@link secureWebPreferences} and loads either the dev server URL or
 * the bundled `index.html`.
 *
 * Why `show: false` + `ready-to-show`: avoids the white-flash on first
 * paint; the window only appears once the renderer has its initial frame.
 *
 * Why `setWindowOpenHandler` denies and shells out: links inside the
 * renderer should open in the user's browser, not in a second Electron
 * window (which would inherit the renderer's privileges).
 *
 * @returns The newly created `BrowserWindow`.
 * @see https://www.electronjs.org/docs/latest/api/browser-window
 */
function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 720,
    minHeight: 400,
    show: false,
    // frame: false removes the OS title bar entirely; the renderer provides a
    // custom drag region + min/max/close cluster in WindowFrame.tsx. autoHide
    // hides the application menu bar (File/Edit/View/Window) — Alt still
    // surfaces it. Together these eliminate the two chrome strips above the
    // feed without losing any keyboard-accessible action.
    frame: false,
    autoHideMenuBar: true,
    title: '',
    webPreferences: secureWebPreferences(join(__dirname, '../preload/index.js')),
  })
  win.on('ready-to-show', () => win.show())
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
  return win
}

app.whenReady().then(() => {
  const userData = app.getPath('userData')
  const notesDir = join(userData, 'notes')
  const logsDir = join(userData, 'logs')
  const dbPath = join(userData, 'linsae.db')
  // notesDir is created by NotesDir's constructor below; only logsDir needs explicit mkdir.
  if (!existsSync(logsDir)) mkdirSync(logsDir, { recursive: true })

  const db = openDb(dbPath)
  runMigrations(db)
  const nd = new NotesDir(notesDir)
  const report = reconcile(db, nd, logsDir)
  // Surfaces the reconciler bucket counts on every launch; renderer reads
  // `report.skipped` via `system:getReconcileSkipped` to drive the banner.
  console.log(`reconciled: ${JSON.stringify(report)}`)

  registerAllIpc(db, nd, notesDir, logsDir, report.skipped)
  buildMenu(notesDir, logsDir)
  mainWindow = createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
