/**
 * IPC handler registration for system / OS-shell channels.
 *
 * Why: Most handlers wrap Electron `shell` / `dialog` and Node `fs` calls with
 * no renderer-supplied input to validate. The exception is `system:chooseFile`,
 * which validates its optional dialog filters via `ChooseFileInputSchema`.
 *
 * @see docs/specs/v0.1-rolling-feed-and-search.md §IPC channels at v0.1
 * @see docs/plans/v0.1-rolling-feed-and-search.md §Task 20 Step 2
 */

import { existsSync, mkdirSync } from 'node:fs'
import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { ChooseFileInputSchema } from '../../shared/zod-schemas'

/**
 * Registers `system:revealNotesFolder`, `system:openLogsFolder`, and
 * `system:getReconcileSkipped` on `ipcMain`.
 *
 * Why `reconcileSkipped` is captured by closure: the value is computed once at
 * startup by the reconciler (spec §Storage architecture / Reconciler algorithm
 * step 6) and is read at most once by the renderer to decide whether to show
 * the malformed-frontmatter banner. A captured constant is simpler than wiring
 * an event channel for a value that never changes during the app's lifetime.
 *
 * `system:openLogsFolder` lazily creates the logs directory because, unlike
 * the notes directory (created by `NotesDir`'s constructor), no other code
 * path is guaranteed to have created it before the user clicks "open logs".
 *
 * @param notesDir - Absolute path to the user's notes directory.
 * @param logsDir - Absolute path to the app's logs directory.
 * @param reconcileSkipped - Cached count of files the startup reconciler
 *   skipped due to malformed frontmatter.
 * @see docs/specs/v0.1-rolling-feed-and-search.md §Storage architecture
 * @see docs/plans/v0.1-rolling-feed-and-search.md §Task 20 Step 2
 */
export function registerSystemIpc(
  notesDir: string,
  logsDir: string,
  reconcileSkipped: number,
): void {
  ipcMain.handle('system:revealNotesFolder', async () => {
    await shell.openPath(notesDir)
    return { ok: true }
  })
  ipcMain.handle('system:openLogsFolder', async () => {
    if (!existsSync(logsDir)) mkdirSync(logsDir, { recursive: true })
    await shell.openPath(logsDir)
    return { ok: true }
  })
  ipcMain.handle('system:getReconcileSkipped', async () => reconcileSkipped)

  // Native open-file picker (used by the "Open PDF…" command before pdf:import).
  // Validates the optional filters with Zod (this is the one system: channel that
  // takes renderer input). Modal to the calling window when one is resolvable —
  // mirrors youtube:importCookies. `filters` is spread conditionally so an absent
  // value is never sent as `undefined` (exactOptionalPropertyTypes).
  ipcMain.handle('system:chooseFile', async (e, input) => {
    const i = ChooseFileInputSchema.parse(input)
    const win = BrowserWindow.fromWebContents(e.sender)
    const opts: Electron.OpenDialogOptions = {
      properties: ['openFile'],
      ...(i?.filters ? { filters: i.filters } : {}),
    }
    const result = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    return { filePaths: result.filePaths }
  })

  // Window controls for the frameless BrowserWindow (frame: false in
  // src/main/index.ts). Resolved per-call via BrowserWindow.fromWebContents
  // so the registrar doesn't have to receive a window handle. Returning
  // {ok:true} keeps the invoke() shape uniform with the other system:* calls.
  ipcMain.handle('system:windowMinimize', async (e) => {
    BrowserWindow.fromWebContents(e.sender)?.minimize()
    return { ok: true }
  })
  ipcMain.handle('system:windowToggleMaximize', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) return { ok: true }
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
    return { ok: true }
  })
  ipcMain.handle('system:windowClose', async (e) => {
    BrowserWindow.fromWebContents(e.sender)?.close()
    return { ok: true }
  })
}
