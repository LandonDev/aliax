import { app } from 'electron'
import electronUpdater from 'electron-updater'
import type { UpdateStatus } from '../shared/types'
import { broadcast } from './events'

const { autoUpdater } = electronUpdater

let status: UpdateStatus = { state: 'idle' }

function set(next: UpdateStatus): void {
  status = next
  broadcast('update:changed', status)
}

export function updateStatus(): UpdateStatus {
  return status
}

/**
 * Download starts only when the user asks — an unrequested background download
 * would fight the CLIs for bandwidth for an update the user may not want yet.
 */
export function downloadUpdate(): void {
  if (status.state !== 'available') return
  autoUpdater.downloadUpdate().catch((e: Error) => set({ state: 'error', error: e.message }))
}

/** Restart into the downloaded build. before-quit cleanup runs as usual. */
export function installUpdate(): void {
  if (status.state !== 'ready') return
  autoUpdater.quitAndInstall()
}

export function startUpdater(): void {
  // In dev there is no app-update.yml and no signed bundle; checking would only
  // log errors.
  if (!app.isPackaged) return

  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('update-available', (info) => set({ state: 'available', version: info.version }))
  autoUpdater.on('download-progress', (p) =>
    set({ state: 'downloading', version: status.version, percent: Math.round(p.percent) })
  )
  autoUpdater.on('update-downloaded', (info) => set({ state: 'ready', version: info.version }))
  autoUpdater.on('error', (e) => {
    // A failed background check is not worth a banner; only surface errors
    // after the user has asked for the update.
    if (status.state === 'downloading') set({ state: 'error', error: e.message })
  })

  let lastCheck = 0
  const check = (): void => {
    if (status.state !== 'idle') return
    lastCheck = Date.now()
    autoUpdater.checkForUpdates().catch(() => {})
  }

  check()
  setInterval(check, 30 * 60_000)

  // Also look whenever the user opens the panel. On the launch-only schedule a
  // release published minutes after startup stayed invisible for the whole
  // interval, so the button was missing exactly when someone went looking for
  // it. Throttled, because opening the panel is a frequent thing to do.
  app.on('browser-window-focus', () => {
    if (Date.now() - lastCheck > 15 * 60_000) check()
  })
}
