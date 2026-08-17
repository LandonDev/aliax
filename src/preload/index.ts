import { contextBridge, ipcRenderer } from 'electron'
import type {
  ActionResult,
  LiveSession,
  ProxyStatus,
  ServiceId,
  ServiceView,
  Settings,
  ShellIntegration,
  ShimStatus,
  UpdateStatus,
  UsageReport,
  WindowMode
} from '../shared/types'
import type { StatsBundle, StatsStatus } from '../shared/stats'

const api = {
  listServices: (): Promise<ServiceView[]> => ipcRenderer.invoke('services:list'),
  capture: (serviceId: ServiceId): Promise<ActionResult> =>
    ipcRenderer.invoke('profiles:capture', serviceId),
  activate: (serviceId: ServiceId, name: string): Promise<ActionResult> =>
    ipcRenderer.invoke('profiles:activate', serviceId, name),
  remove: (serviceId: ServiceId, name: string): Promise<ActionResult> =>
    ipcRenderer.invoke('profiles:delete', serviceId, name),
  usage: (serviceId: ServiceId, force?: boolean): Promise<UsageReport[]> =>
    ipcRenderer.invoke('usage:get', serviceId, force),
  loginStart: (serviceId: ServiceId, loginHint?: string): Promise<ActionResult> =>
    ipcRenderer.invoke('login:start', serviceId, loginHint),
  loginCancel: (serviceId: ServiceId): Promise<void> =>
    ipcRenderer.invoke('login:cancel', serviceId),
  updateProfile: (
    serviceId: ServiceId,
    name: string,
    patch: { nickname?: string; color?: string }
  ): Promise<ActionResult> => ipcRenderer.invoke('profiles:update', serviceId, name, patch),
  getSettings: (): Promise<Settings> => ipcRenderer.invoke('settings:get'),
  setSettings: (settings: Settings): Promise<ActionResult> =>
    ipcRenderer.invoke('settings:set', settings),
  setWindowMode: (mode: WindowMode): Promise<ActionResult> => ipcRenderer.invoke('ui:setMode', mode),
  proxyStatus: (): Promise<{ proxy: ProxyStatus; shell: ShellIntegration; shim: ShimStatus }> =>
    ipcRenderer.invoke('proxy:status'),
  proxySetEnabled: (enabled: boolean): Promise<ActionResult> =>
    ipcRenderer.invoke('proxy:setEnabled', enabled),
  proxyInstallShell: (): Promise<ActionResult> => ipcRenderer.invoke('proxy:installShell'),
  proxyRemoveShell: (): Promise<ActionResult> => ipcRenderer.invoke('proxy:removeShell'),
  proxySessions: (): Promise<LiveSession[]> => ipcRenderer.invoke('proxy:sessions'),
  proxyAdopt: (): Promise<ActionResult> => ipcRenderer.invoke('proxy:adopt'),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke('open:external', url),
  /** Fires when accounts change outside this window (e.g. a menu bar switch). */
  onAccountsChanged: (cb: () => void): (() => void) => {
    const listener = (): void => cb()
    ipcRenderer.on('accounts:changed', listener)
    return () => ipcRenderer.removeListener('accounts:changed', listener)
  },
  updateStatus: (): Promise<UpdateStatus> => ipcRenderer.invoke('update:status'),
  updateDownload: (): Promise<void> => ipcRenderer.invoke('update:download'),
  updateInstall: (): Promise<void> => ipcRenderer.invoke('update:install'),
  onUpdateChanged: (cb: (status: UpdateStatus) => void): (() => void) => {
    const listener = (_e: unknown, status: UpdateStatus): void => cb(status)
    ipcRenderer.on('update:changed', listener)
    return () => ipcRenderer.removeListener('update:changed', listener)
  },
  stats: (): Promise<StatsBundle> => ipcRenderer.invoke('stats:get'),
  statsStatus: (): Promise<StatsStatus> => ipcRenderer.invoke('stats:status'),
  statsReindex: (): Promise<ActionResult> => ipcRenderer.invoke('stats:reindex')
}

contextBridge.exposeInMainWorld('aliax', api)

export type AliaxApi = typeof api
