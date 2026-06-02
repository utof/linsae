/**
 * IPC handlers for YouTube account auth, driven by Settings → "YouTube account".
 *
 * No renderer-supplied input to validate (the cookies-file path comes from a native dialog,
 * not the renderer), so — like src/main/ipc/system.ts — there is no Zod schema. Each handler
 * delegates to the tested helpers in yt-cookies / yt-login.
 *
 * @see adrs/0017-youtube-auth-cookie-and-servicelogin.md
 */
import { BrowserWindow, dialog, ipcMain } from 'electron'
import { importCookiesFromFile, isYoutubeAuthenticated, signOutYoutube } from '../yt-cookies'
import { openYoutubeLoginWindow } from '../yt-login'

/** Registers `youtube:authStatus / signIn / signOut / importCookies` on `ipcMain`. */
export function registerYoutubeAuthIpc(): void {
  ipcMain.handle('youtube:authStatus', async () => ({ signedIn: await isYoutubeAuthenticated() }))

  ipcMain.handle('youtube:signIn', async () => {
    openYoutubeLoginWindow()
    return { ok: true as const }
  })

  ipcMain.handle('youtube:signOut', async () => {
    await signOutYoutube()
    return { ok: true as const }
  })

  ipcMain.handle('youtube:importCookies', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const opts: Electron.OpenDialogOptions = {
      title: 'Import YouTube cookies (Netscape cookies.txt)',
      properties: ['openFile'],
      filters: [{ name: 'cookies', extensions: ['txt'] }],
    }
    const result = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    const file = result.filePaths[0]
    if (result.canceled || !file) return { canceled: true as const }
    const { ok, fail } = await importCookiesFromFile(file)
    return { canceled: false as const, ok, fail }
  })
}
