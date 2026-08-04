import { app } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ServiceId, Settings } from '../shared/types'

const DEFAULTS: Settings = { windowMode: 'normal', switchTargets: {} }

const path = (): string => join(app.getPath('userData'), 'settings.json')

export function getSettings(): Settings {
  try {
    return { ...DEFAULTS, ...JSON.parse(readFileSync(path(), 'utf8')) }
  } catch {
    return { ...DEFAULTS }
  }
}

export function saveSettings(settings: Settings): void {
  writeFileSync(path(), JSON.stringify(settings, null, 2))
}

/** Enabled switch targets for a service; targets default to on unless toggled off. */
export function enabledTargets(serviceId: ServiceId, allTargets: { id: string }[]): Set<string> {
  const overrides = getSettings().switchTargets[serviceId] ?? {}
  return new Set(allTargets.filter((t) => overrides[t.id] !== false).map((t) => t.id))
}
