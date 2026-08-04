import { app, safeStorage } from 'electron'
import { spawnSync } from 'node:child_process'
import { createDecipheriv, pbkdf2Sync } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomAccountColor } from '../shared/colors'
import type { ServiceId } from '../shared/types'

export interface StoredProfile {
  name: string
  accountId: string
  email?: string
  nickname?: string
  color?: string
  /** True once a claude.ai-style app session is stored alongside the credentials. */
  hasAppSession?: boolean
  createdAt: number
  lastActivatedAt?: number
}

type Meta = Partial<Record<ServiceId, StoredProfile[]>>

const metaPath = (): string => join(app.getPath('userData'), 'profiles.json')

function secretsDir(): string {
  const dir = join(app.getPath('userData'), 'secrets')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  return dir
}

const fileStem = (serviceId: ServiceId, name: string): string =>
  join(secretsDir(), `${serviceId}__${encodeURIComponent(name)}`)

export function loadMeta(): Meta {
  try {
    return JSON.parse(readFileSync(metaPath(), 'utf8'))
  } catch {
    return {}
  }
}

export function saveMeta(meta: Meta): void {
  writeFileSync(metaPath(), JSON.stringify(meta, null, 2), { mode: 0o600 })
}

export function profiles(serviceId: ServiceId): StoredProfile[] {
  return loadMeta()[serviceId] ?? []
}

export function upsertProfile(serviceId: ServiceId, profile: StoredProfile): void {
  const meta = loadMeta()
  const list = meta[serviceId] ?? []
  // Every account carries a colour from birth; the UI leans on it for identity.
  if (!profile.color) profile.color = randomAccountColor(list.map((p) => p.color))
  const i = list.findIndex((p) => p.name === profile.name)
  if (i >= 0) list[i] = profile
  else list.push(profile)
  meta[serviceId] = list
  saveMeta(meta)
}

/** One-time backfill: accounts saved before colours existed get one at startup. */
export function ensureColors(): void {
  const meta = loadMeta()
  let changed = false
  for (const list of Object.values(meta)) {
    for (const p of list) {
      if (p.color) continue
      p.color = randomAccountColor(list.map((q) => q.color))
      changed = true
    }
  }
  if (changed) saveMeta(meta)
}

export function deleteProfile(serviceId: ServiceId, name: string): void {
  const meta = loadMeta()
  meta[serviceId] = (meta[serviceId] ?? []).filter((p) => p.name !== name)
  saveMeta(meta)
  for (const suffix of ['bin', 'claude-desktop.tar.gz']) {
    rmSync(`${fileStem(serviceId, name)}.${suffix}`, { force: true })
  }
}

export function saveSecret(serviceId: ServiceId, name: string, blob: string): void {
  writeFileSync(`${fileStem(serviceId, name)}.bin`, safeStorage.encryptString(blob), { mode: 0o600 })
}

/**
 * Names this app has run under. `safeStorage` derives its key from a Keychain
 * item called "<app name> Safe Storage" and looks it up case-sensitively, so
 * every rename — dev vs packaged, most of all — strands the blobs written under
 * the previous name (invariant 17).
 */
const PAST_APP_NAMES = ['aliax', 'Aliax', 'Electron']

/**
 * Decrypt a blob written under a DIFFERENT app name, using the same scheme
 * Chromium's OSCrypt uses on macOS: AES-128-CBC, key = PBKDF2-SHA1(keychain
 * password, "saltysalt", 1003), IV of 16 spaces, after the "v10" tag. Reading
 * another item's password may raise one Keychain prompt, hence the timeout —
 * a stuck prompt must never hang a usage poll.
 */
function decryptWithPastKey(buf: Buffer): string | null {
  if (process.platform !== 'darwin' || buf.subarray(0, 3).toString() !== 'v10') return null
  for (const appName of PAST_APP_NAMES) {
    if (appName === app.getName()) continue
    const found = spawnSync(
      'security',
      ['find-generic-password', '-w', '-s', `${appName} Safe Storage`],
      { encoding: 'utf8', timeout: 10_000 }
    )
    if (found.status !== 0 || !found.stdout) continue
    try {
      const key = pbkdf2Sync(found.stdout.trim(), 'saltysalt', 1003, 16, 'sha1')
      const decipher = createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, ' '))
      return Buffer.concat([decipher.update(buf.subarray(3)), decipher.final()]).toString('utf8')
    } catch {
      // wrong key for this blob; try the next name
    }
  }
  return null
}

export function readSecret(serviceId: ServiceId, name: string): string | null {
  const path = `${fileStem(serviceId, name)}.bin`
  if (!existsSync(path)) return null
  const raw = readFileSync(path)
  try {
    return safeStorage.decryptString(raw)
  } catch (e) {
    const recovered = decryptWithPastKey(raw)
    if (recovered === null) throw e
    // Re-encrypt under the current name so this costs nothing next time.
    saveSecret(serviceId, name, recovered)
    return recovered
  }
}

/** Path for an adapter's larger side file (e.g. an app-session archive) tied to a profile. */
export function extraPath(serviceId: ServiceId, name: string, suffix: string): string {
  return `${fileStem(serviceId, name)}.${suffix}`
}

/** Move side files captured under a placeholder profile name to the real one. */
export function adoptExtras(serviceId: ServiceId, from: string, to: string): void {
  const dir = secretsDir()
  const fromPrefix = `${serviceId}__${encodeURIComponent(from)}.`
  const toPrefix = `${serviceId}__${encodeURIComponent(to)}.`
  for (const f of readdirSync(dir)) {
    if (f.startsWith(fromPrefix) && !f.endsWith('.bin')) {
      renameSync(join(dir, f), join(dir, toPrefix + f.slice(fromPrefix.length)))
    }
  }
}
