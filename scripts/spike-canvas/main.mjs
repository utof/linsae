// Bare Electron main for the canvas substrate spike — no linsae app code.
// Why: docs/research/2026-06-11-canvas-architecture-synthesis-v2.md §Stage 0.
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow } from 'electron'

const here = dirname(fileURLToPath(import.meta.url))

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    backgroundColor: '#fafafa',
    webPreferences: { backgroundThrottling: false },
  })
  win.loadFile(join(here, 'page', 'index.html'), {
    query: { mode: process.env.SPIKE_MODE || 'bench' },
  })
})

app.on('window-all-closed', () => app.quit())
