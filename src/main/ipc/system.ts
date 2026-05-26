/**
 * IPC handler registration for system / OS-shell channels.
 *
 * Why: These handlers wrap Electron `shell` and Node `fs` calls — there is no
 * renderer-supplied input to validate, so no Zod schema is involved.
 *
 * @see docs/specs/v0.1-rolling-feed-and-search.md §IPC channels at v0.1
 * @see docs/plans/v0.1-rolling-feed-and-search.md §Task 20 Step 2
 */

import { existsSync, mkdirSync } from 'node:fs'
import { ipcMain, shell } from 'electron'

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
}
