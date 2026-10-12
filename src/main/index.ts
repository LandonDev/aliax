import { app, BrowserWindow, net, safeStorage, shell } from 'electron'
import { join } from 'node:path'
import { statSync, watch } from 'node:fs'
import { accounts, configure, getSettings, saveSettings } from 'aliax-core'
import { registerIpc } from './ipc'
import { clearRuntimeFile, role, startProxy, stopProxy } from './proxy'
import { refreshShim, resumePendingRemoval } from './shim'
import { broadcast, setBroadcast } from './events'
import { recordAppEvent, recordUsage } from './stats/store'
import { createTray, refreshTray } from './tray'
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

/**
 * temp-code shares the vault, the pin and the usage cache in userData. One
 * watch on the directory notices its writes; our own writes already redraw
 * through the core's hook, so only a pin we did not set or a cache we did not
 * write gets a broadcast.
 */
function watchDataDir(): void {
  const dir = app.getPath('userData')
  let pins = JSON.stringify(getSettings().proxyAccounts ?? {})
  let timer: NodeJS.Timeout | null = null
  const check = (): void => {
    timer = null
    const nowPins = JSON.stringify(getSettings().proxyAccounts ?? {})
    const pinMoved = nowPins !== pins
    pins = nowPins
    let cacheMtime = 0
    try {
      cacheMtime = statSync(join(dir, 'usage-cache.json')).mtimeMs
    } catch {
      // no cache yet
    }
    const cacheMoved = cacheMtime !== 0 && cacheMtime !== accounts.cacheMtimeSeen()
    if (!pinMoved && !cacheMoved) return
    broadcast('accounts:changed')
    refreshTray()
  }
  try {
    const watcher = watch(dir, (_event, file) => {
      if (file !== 'settings.json' && file !== 'usage-cache.json') return
      if (timer) clearTimeout(timer)
      timer = setTimeout(check, 200)
    })
    watcher.on('error', () => {})
  } catch {
    // without a watcher the 60 s tray refresh still catches up
  }
}

// Do NOT app.setName here: safeStorage keys the Keychain item by app name
// ("<name> Safe Storage"), so a runtime rename orphans every stored secret.
// The packaged app takes its name from productName instead.

app.whenReady().then(() => {
  // Everything in aliax-core reads the vault, settings and usage cache through
  // this: Aliax keeps its own safeStorage key and name, so nothing on disk moves.
  configure({
    dataDir: app.getPath('userData'),
    fetch: (input, init) => net.fetch(input, init),
    secrets: {
      mode: 'safeStorage',
      encrypt: (plain) => safeStorage.encryptString(plain),
      decrypt: (blob) => safeStorage.decryptString(blob)
    },
    appName: app.getName(),
    hooks: {
      onUsageSample: (s) =>
        recordUsage(s.service, s.account, s.label, s.usedPercent, s.resetsAt, s.periodMs),
      onAppEvent: recordAppEvent,
      onAccountsChanged: () => broadcast('accounts:changed')
    },
    role
  })
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
  resumePendingRemoval()
    .then(refreshShim)
    .catch((e) => console.warn(`[shim] refresh failed: ${e instanceof Error ? e.message : e}`))
  if (getSettings().proxyEnabled) startProxy().catch(() => {})
  watchDataDir()

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
