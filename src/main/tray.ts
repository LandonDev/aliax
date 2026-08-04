import { app, Menu, nativeImage, Notification, Tray } from 'electron'
import { join } from 'node:path'
import type { ServiceId, UsageReport, UsageWindow } from '../shared/types'
import { healthOf, onPaceLeft, percentLeft, type Health } from '../shared/health'
import * as accounts from './accounts'
import { broadcast } from './events'
import { getSettings, saveSettings } from './settings'

let tray: Tray | null = null
let building = false
// Injected rather than imported: tray is created from index.ts, and importing
// back into it would make a cycle that leaves createTray undefined at call time.
let openWindow: () => void = () => {}

/** Same palette the app's bars use (status colours from lib/viz). */
const FILL: Record<Health, [number, number, number]> = {
  good: [0x19, 0x9e, 0x70],
  warning: [0xc9, 0x85, 0x00],
  critical: [0xe3, 0x49, 0x48]
}

/**
 * A real usage bar, drawn as the menu item's icon — the block-character bars
 * were unreadable next to proportional menu text. Drawn at 2x into raw BGRA
 * (premultiplied, as createFromBitmap expects): a grey track, a health-coloured
 * fill for what's LEFT, and a notch at the on-pace point, mirroring the app.
 */
function barImage(w: UsageWindow, now: number): Electron.NativeImage {
  const W = 112
  const H = 44 // menu row height at 2x; the bar floats vertically centred
  const barH = 12
  const top = (H - barH) / 2
  const r = barH / 2
  const left = percentLeft(w)
  const fill = FILL[healthOf(w, now)]
  const budget = onPaceLeft(w, now)
  const fillW = Math.round((left / 100) * W)
  const tickX = budget !== null && budget > 3 && budget < 97 ? Math.round((budget / 100) * W) : -1

  const buf = Buffer.alloc(W * H * 4)
  const put = (x: number, y: number, rgb: [number, number, number], a: number): void => {
    const i = (y * W + x) * 4
    // BGRA, premultiplied
    buf[i] = Math.round((rgb[2] * a) / 255)
    buf[i + 1] = Math.round((rgb[1] * a) / 255)
    buf[i + 2] = Math.round((rgb[0] * a) / 255)
    buf[i + 3] = a
  }
  for (let y = 0; y < barH; y++) {
    for (let x = 0; x < W; x++) {
      // Rounded ends: skip corner pixels outside the end-cap circles.
      const dy = y + 0.5 - barH / 2
      const capL = x + 0.5 < r ? Math.hypot(x + 0.5 - r, dy) > r : false
      const capR = x + 0.5 > W - r ? Math.hypot(x + 0.5 - (W - r), dy) > r : false
      if (capL || capR) continue
      const inFill = x < fillW
      if (x === tickX || x === tickX + 1) {
        // The on-pace notch: dark over fill, light over track, visible on both.
        put(x, top + y, inFill ? [0, 0, 0] : [255, 255, 255], inFill ? 140 : 200)
      } else if (inFill) {
        put(x, top + y, fill, 255)
      } else {
        put(x, top + y, [128, 128, 128], 56)
      }
    }
  }
  return nativeImage.createFromBitmap(buf, { width: W, height: H, scaleFactor: 2 })
}

function label(profile: { nickname?: string; email?: string; name: string }): string {
  return profile.nickname ?? profile.email ?? profile.name
}

/** The window worth showing in a one-line summary: whichever has least headroom. */
function tightest(report: UsageReport | undefined): UsageWindow | null {
  if (!report || report.windows.length === 0) return null
  return report.windows.reduce((a, b) => (percentLeft(a) <= percentLeft(b) ? a : b))
}

async function build(): Promise<void> {
  if (!tray || building) return
  building = true
  try {
    const now = Date.now()
    const views = await accounts.listServices()
    const usage: Partial<Record<ServiceId, UsageReport[]>> = {}
    for (const v of views) {
      if (v.installed) usage[v.id] = await accounts.usage(v.id).catch(() => [])
    }

    const template: Electron.MenuItemConstructorOptions[] = []
    for (const view of views) {
      if (!view.installed || view.profiles.length === 0) continue
      template.push({ label: view.name, enabled: false })
      for (const p of view.profiles) {
        const report = usage[view.id]?.find((r) => r.profileName === p.name)
        const w = tightest(report)
        template.push({
          // The check mark is the active account: a native menu already has a
          // language for "this is the current one", so don't invent another.
          type: 'checkbox',
          checked: p.active,
          label: w
            ? `${label(p)}    ${Math.round(percentLeft(w))}% ${w.label}`
            : label(p),
          icon: w ? barImage(w, now) : undefined,
          toolTip: p.active ? 'Active account' : `Switch ${view.name} to this account`,
          // Switching to the account you are already on would restart sessions
          // for nothing.
          enabled: !p.active,
          click: () => {
            void switchTo(view.id, p.name)
          }
        })
      }
      template.push({ type: 'separator' })
    }
    if (template.length === 0) template.push({ label: 'No accounts saved', enabled: false })

    template.push(
      { label: 'Open Aliax', click: () => openWindow() },
      {
        label: 'Open at login',
        type: 'checkbox',
        checked: app.getLoginItemSettings().openAtLogin,
        click: (item) => setLaunchAtLogin(item.checked)
      },
      { type: 'separator' },
      { label: 'Quit Aliax', role: 'quit' }
    )

    tray.setContextMenu(Menu.buildFromTemplate(template))
  } finally {
    building = false
  }
}

async function switchTo(serviceId: ServiceId, name: string): Promise<void> {
  // A menu has no toast: without a notification, a failed switch is just a
  // check mark that never moved, which looks like a bug (invariant 5).
  const result = await accounts
    .activate(serviceId, name)
    .catch((e: Error) => ({ ok: false as const, error: e.message }))
  if (!result.ok) {
    new Notification({ title: 'Switch failed', body: result.error }).show()
  } else if (result.notes?.length) {
    new Notification({ title: `Switched to ${name}`, body: result.notes.join(' · ') }).show()
  }
  // The open window polls on its own schedule; a switch made out here would sit
  // invisible in it until then, which reads as "the switch didn't work".
  broadcast('accounts:changed')
  refreshTray()
}

/** Rebuild the menu from current state. Safe to call often; polls are cached. */
export function refreshTray(): void {
  build().catch(() => {})
}

export function setLaunchAtLogin(enabled: boolean): void {
  // openAsHidden keeps a login launch from stealing focus; the menu bar is the
  // point of starting at login, not the window.
  app.setLoginItemSettings({ openAtLogin: enabled, openAsHidden: true })
  saveSettings({ ...getSettings(), launchAtLogin: enabled })
}

export function createTray(onOpen: () => void): void {
  if (tray) return
  openWindow = onOpen
  // Packaged, the icon ships as an extraResource: an asar path is not a real
  // file, so nativeImage cannot read it from inside the archive.
  const iconPath = app.isPackaged
    ? join(process.resourcesPath, 'trayTemplate.png')
    : join(__dirname, '../../build/trayTemplate.png')
  const icon = nativeImage.createFromPath(iconPath)
  if (icon.isEmpty()) {
    console.error(`[tray] icon failed to load from ${iconPath}`)
    return
  }
  // A template image lets macOS invert it for light/dark menu bars.
  icon.setTemplateImage(true)
  tray = new Tray(icon)
  tray.setToolTip('Aliax')
  refreshTray()
  // Menus are built ahead of opening, so keep the numbers from going stale.
  setInterval(refreshTray, 60_000)
}

export function destroyTray(): void {
  tray?.destroy()
  tray = null
}
