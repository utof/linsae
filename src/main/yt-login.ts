/**
 * Dedicated top-level window for YouTube/Google sign-in (ADR 0017).
 *
 * Google refuses sign-in inside an embedded `<webview>`, AND its modern `/v3/signin`
 * (GlifWebSignIn) flow rejects an Electron BrowserWindow as "not secure" even with a clean
 * Chrome UA — UA/client-hint spoofing can't be made consistent in Electron (electron#34481,
 * #34762). The working path, shipped by ytmdesktop & th-ch/youtube-music in 2026, is to load
 * the LEGACY `accounts.google.com/ServiceLogin?service=youtube` page directly (not gated that
 * way) with the DEFAULT UA. It shares the `persist:yt-player` partition, so the resulting
 * cookies persist for the player webview. The user logs in, then closes the window.
 *
 * Triggered from Settings via the `youtube:signIn` IPC (src/main/ipc/youtube-auth.ts).
 *
 * @see adrs/0017-youtube-auth-cookie-and-servicelogin.md
 * @see https://github.com/ytmdesktop/ytmdesktop (src/main ServiceLogin redirect)
 */
import { BrowserWindow, shell } from 'electron'

// Google/YouTube hosts whose sign-in popups (e.g. a security-key / passkey prompt) we allow
// to open in-app; everything else shells out to the real browser.
const ALLOW_POPUP =
  /(?:^|\.)(?:youtube\.com|google\.com|googleapis\.com|gstatic\.com|youtube-nocookie\.com)$/

/** Open the ServiceLogin window on the `persist:yt-player` partition. */
export function openYoutubeLoginWindow(): void {
  const win = new BrowserWindow({
    width: 980,
    height: 760,
    title: 'Sign in to YouTube',
    autoHideMenuBar: true,
    webPreferences: {
      partition: 'persist:yt-player',
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    let host = ''
    try {
      host = new URL(url).hostname
    } catch {
      return { action: 'deny' }
    }
    if (ALLOW_POPUP.test(host)) return { action: 'allow' }
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  // Load the LEGACY "One account. All of Google" sign-in page directly (default UA, no
  // spoofing) — not youtube.com, which bounces into the gated /v3/signin flow.
  const next = encodeURIComponent('https://www.youtube.com/')
  const cont = encodeURIComponent(
    `https://www.youtube.com/signin?action_handle_signin=true&app=desktop&next=${next}`,
  )
  void win.loadURL(
    `https://accounts.google.com/ServiceLogin?ltmpl=music&service=youtube&continue=${cont}`,
  )
}
