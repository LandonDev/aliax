import { app, BrowserWindow, shell } from 'electron'
import { join } from 'node:path'
import { registerIpc } from './ipc'
import { clearRuntimeFile, startProxy, stopProxy } from './proxy'
import { resumePendingRemoval } from './shim'
import { setBroadcast } from './events'
import { getSettings, saveSettings } from './settings'
import { createTray } from './tray'
import { startUpdater } from './updater'
import type { WindowMode } from '../shared/types'

const SIZES: Record<WindowMode, { width: number; height: number; minWidth: number; minHeight: number }> = {
  // Normal fits a full account row (name, surfaces, two usage windows, actions)
  // without the usage columns collapsing, with room for the stats page to breathe.
  normal: { width: 1280, height: 900, minWidth: 980, minHeight: 560 },
  mini: { width: 372, height: 460, minWidth: 340, minHeight: 320 }
}

let win: BrowserWindow | null = null

/** Bring the app forward, recreating the window if it was closed. */
export function showWindow(): void {
  if (!win) createWindow()
  win?.show()
  app.focus({ steal: true })
}

export function applyWindowMode(mode: WindowMode): void {
  if (!win) return
  const size = SIZES[mode]
  win.setMinimumSize(size.minWidth, size.minHeight)
  win.setSize(size.width, size.height, true)
  win.setAlwaysOnTop(mode === 'mini')
  const settings = getSettings()
  saveSettings({ ...settings, windowMode: mode })
}

function createWindow(): void {
  const mode = getSettings().windowMode
  const size = SIZES[mode]
  win = new BrowserWindow({
    width: size.width,
    height: size.height,
    minWidth: size.minWidth,
    minHeight: size.minHeight,
    show: false,
    alwaysOnTop: mode === 'mini',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js')
    }
  })

  win.on('ready-to-show', () => win?.show())
  win.on('closed', () => (win = null))

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (!app.isPackaged && devUrl) {
    win.loadURL(devUrl)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// Do NOT app.setName here: safeStorage keys the Keychain item by app name
// ("<name> Safe Storage"), so a runtime rename orphans every stored secret.
// The packaged app takes its name from productName instead.

app.whenReady().then(() => {
  // Packaged builds get the icon and name from the bundle; dev runs need both
  // set at runtime or the dock shows Electron.
  if (!app.isPackaged && process.platform === 'darwin') {
    app.dock?.setIcon(join(__dirname, '../../build/icon.png'))
  }
  setBroadcast((channel, payload) => win?.webContents.send(channel, payload))
  registerIpc()
  createWindow()
  createTray(showWindow)
  startUpdater()
  resumePendingRemoval().catch(() => {})
  if (getSettings().proxyEnabled) startProxy().catch(() => {})

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// The shell snippet routes only while the marker file names a live pid, so the
// marker must not outlive us. `before-quit` covers the normal path; the signal
// and exit handlers cover kills and crashes, since a stale marker pointing at a
// dead port would break every new shell.
app.on('before-quit', () => {
  stopProxy().catch(() => {})
  clearRuntimeFile()
})
process.on('exit', clearRuntimeFile)
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(signal, () => {
    clearRuntimeFile()
    app.quit()
  })
}
