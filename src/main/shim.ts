import { app } from 'electron'
import { execFile } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { ShimStatus } from '../shared/types'
import { processCommand, processEnv, RUNTIME_DIR } from 'aliax-core'

const exec = promisify(execFile)

/**
 * Installs the shim: a small helper that owns one fixed port for good, so the
 * CLIs' config can name a stable endpoint. Config is the only route to sessions
 * launched inside GUI apps, which never read your shell. The shim forwards to
 * Aliax when it is running and straight to the provider when it is not, so a
 * closed or crashed Aliax cannot break anything.
 */
export const SHIM_PORT = 8787
export const SHIM_URL = `http://127.0.0.1:${SHIM_PORT}`
/** Codex 0.158+ refuses a ChatGPT base that is not HTTPS: it gets the shim's TLS port. */
export const SHIM_TLS_PORT = 8789
export const CODEX_SHIM_URL = `https://127.0.0.1:${SHIM_TLS_PORT}`
/** The base Aliax wrote before the TLS port; still Aliax's own when it meets it. */
const LEGACY_CODEX_BASE = `${SHIM_URL}/codex`
const CODEX_BASE = `${CODEX_SHIM_URL}/codex`

const LABEL = 'com.aliax.shim'
const SCRIPT_PATH = join(RUNTIME_DIR, 'aliax-shim.mjs')
const PLIST_PATH = join(homedir(), 'Library/LaunchAgents', `${LABEL}.plist`)
const LOG_PATH = join(RUNTIME_DIR, 'shim.log')
const REMOVE_PENDING_PATH = join(RUNTIME_DIR, 'shim-remove-pending')
/** The shim's certificate; the user trusts ca.pem in Keychain once. */
export const TLS_DIR = join(RUNTIME_DIR, 'tls')
export const TLS_CA_PATH = join(TLS_DIR, 'ca.pem')
let cleanupTimer: NodeJS.Timeout | null = null

/**
 * NOTE for packaging: `resources/aliax-shim.mjs` must be shipped as an extra
 * resource (electron-builder `extraResources`), or installing the helper will
 * fail in a built app.
 */
const sourceScript = (): string =>
  app.isPackaged
    ? join(process.resourcesPath, 'aliax-shim.mjs')
    : join(app.getAppPath(), 'resources/aliax-shim.mjs')

/** Absolute node path: launchd runs with a minimal PATH of its own. */
async function nodePath(): Promise<string> {
  for (const candidate of ['/opt/homebrew/bin/node', '/usr/local/bin/node']) {
    if (existsSync(candidate)) return candidate
  }
  const { stdout } = await exec('/bin/sh', ['-lc', 'command -v node'])
  const found = stdout.trim()
  if (!found) throw new Error('node was not found; instant switching needs it for the helper')
  return found
}

const plist = (node: string): string => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${node}</string><string>${SCRIPT_PATH}</string></array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>ALIAX_SHIM_PORT</key><string>${SHIM_PORT}</string>
    <key>ALIAX_SHIM_TLS_PORT</key><string>${SHIM_TLS_PORT}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${LOG_PATH}</string>
  <key>StandardErrorPath</key><string>${LOG_PATH}</string>
</dict>
</plist>
`

/** Is the helper answering right now? Asked of the port, not of launchd. */
async function responding(): Promise<boolean> {
  try {
    const res = await fetch(`${SHIM_URL}/__shim`, { signal: AbortSignal.timeout(1500) })
    return res.ok
  } catch {
    return false
  }
}

const OPENSSL = ['/opt/homebrew/bin/openssl', '/usr/local/bin/openssl'].find(existsSync) ?? '/usr/bin/openssl'

/**
 * A local CA and a 127.0.0.1 certificate it signs, made once. The CA's key
 * is deleted as soon as the leaf is signed: the CA the user trusts can
 * never vouch for anything else. A lapsed leaf means a new pair (and a new
 * Keychain trust).
 */
async function ensureCertificate(): Promise<void> {
  const cert = join(TLS_DIR, 'cert.pem')
  const key = join(TLS_DIR, 'key.pem')
  if (existsSync(cert) && existsSync(key) && existsSync(TLS_CA_PATH)) {
    const valid = await exec(OPENSSL, ['x509', '-checkend', String(7 * 86400), '-noout', '-in', cert])
      .then(() => true)
      .catch(() => false)
    if (valid) return
  }
  rmSync(TLS_DIR, { recursive: true, force: true })
  mkdirSync(TLS_DIR, { recursive: true, mode: 0o700 })
  const at = (name: string): string => join(TLS_DIR, name)
  writeFileSync(
    at('ca.cnf'),
    [
      '[req]',
      'distinguished_name = dn',
      'prompt = no',
      'x509_extensions = v3_ca',
      '[dn]',
      'CN = Aliax Local CA',
      '[v3_ca]',
      'basicConstraints = critical, CA:true, pathlen:0',
      'keyUsage = critical, keyCertSign, cRLSign',
      'subjectKeyIdentifier = hash',
      ''
    ].join('\n')
  )
  writeFileSync(
    at('leaf.ext'),
    [
      'basicConstraints = critical, CA:false',
      'keyUsage = critical, digitalSignature',
      'extendedKeyUsage = serverAuth',
      'subjectAltName = IP:127.0.0.1, DNS:localhost',
      ''
    ].join('\n')
  )
  const ec = ['ecparam', '-name', 'prime256v1', '-genkey', '-noout']
  await exec(OPENSSL, [...ec, '-out', at('ca-key.pem')])
  await exec(OPENSSL, ['req', '-x509', '-new', '-key', at('ca-key.pem'), '-out', TLS_CA_PATH, '-days', '3650', '-config', at('ca.cnf')])
  await exec(OPENSSL, [...ec, '-out', key])
  await exec(OPENSSL, ['req', '-new', '-key', key, '-out', at('leaf.csr'), '-subj', '/CN=127.0.0.1'])
  // 820 days: macOS refuses TLS leaves valid for more than 825.
  await exec(OPENSSL, ['x509', '-req', '-in', at('leaf.csr'), '-CA', TLS_CA_PATH, '-CAkey', at('ca-key.pem'), '-set_serial', `0x${Date.now().toString(16)}`, '-out', cert, '-days', '820', '-extfile', at('leaf.ext')])
  for (const name of ['ca-key.pem', 'leaf.csr', 'ca.cnf', 'leaf.ext']) rmSync(at(name), { force: true })
}

/**
 * `launchctl bootout` returns before launchd has finished tearing the old
 * instance down, and a bootstrap of the same label in that gap fails with
 * "Bootstrap failed: 5: Input/output error" (reproduced on 2026-10-12: the
 * v0.1.17 launch-time reinstall hit it and left the helper unloaded, so every
 * CLI pointed at 8787/8789 got ECONNREFUSED). Retry until launchd lists the
 * label, for up to five seconds.
 */
async function bootstrap(uid: number): Promise<void> {
  const loaded = (): Promise<boolean> => exec('launchctl', ['print', `gui/${uid}/${LABEL}`]).then(() => true, () => false)
  let lastError: unknown
  for (let i = 0; i < 20; i++) {
    try {
      await exec('launchctl', ['bootstrap', `gui/${uid}`, PLIST_PATH])
      return
    } catch (error) {
      lastError = error
      if (await loaded()) return
      await new Promise((r) => setTimeout(r, 250))
    }
  }
  throw lastError
}

export async function shimStatus(): Promise<ShimStatus> {
  return { installed: existsSync(PLIST_PATH), running: await responding(), port: SHIM_PORT }
}

export async function installShim(): Promise<ShimStatus> {
  if (cleanupTimer) {
    clearTimeout(cleanupTimer)
    cleanupTimer = null
  }
  rmSync(REMOVE_PENDING_PATH, { force: true })
  mkdirSync(RUNTIME_DIR, { recursive: true, mode: 0o700 })
  copyFileSync(sourceScript(), SCRIPT_PATH)
  // Without a certificate the shim still serves plain HTTP; only Codex 0.158+ needs TLS.
  await ensureCertificate().catch((e) => console.warn(`[shim] no TLS certificate: ${e instanceof Error ? e.message : e}`))
  mkdirSync(join(homedir(), 'Library/LaunchAgents'), { recursive: true })
  writeFileSync(PLIST_PATH, plist(await nodePath()), { mode: 0o644 })

  const uid = process.getuid?.() ?? 501
  // bootout first so a reinstall picks up a changed script or node path.
  await exec('launchctl', ['bootout', `gui/${uid}/${LABEL}`]).catch(() => {})
  await bootstrap(uid)
  for (let i = 0; i < 20 && !(await responding()); i++) {
    await new Promise((r) => setTimeout(r, 250))
  }
  const status = await shimStatus()
  if (!status.running) {
    await uninstallShim()
    throw new Error('the background helper did not start; CLI settings were left unchanged')
  }
  return status
}

async function uninstallShim(): Promise<ShimStatus> {
  const uid = process.getuid?.() ?? 501
  await exec('launchctl', ['bootout', `gui/${uid}/${LABEL}`]).catch(() => {})
  rmSync(PLIST_PATH, { force: true })
  rmSync(SCRIPT_PATH, { force: true })
  rmSync(REMOVE_PENDING_PATH, { force: true })
  return shimStatus()
}

/** Pids that captured the shim endpoint when they started and still need it. */
async function liveShimConsumers(): Promise<number[] | null> {
  try {
    const consumers = new Set<number>()
    for (const name of ['claude', 'codex']) {
      let pids: number[] = []
      try {
        const { stdout } = await exec('pgrep', ['-x', name])
        pids = stdout
          .trim()
          .split('\n')
          .filter(Boolean)
          .map(Number)
      } catch {
        // No process with this name is running.
      }
      for (const pid of pids) {
        let usesShim: boolean
        if (name === 'claude') {
          usesShim = (await processEnv(pid)).ANTHROPIC_BASE_URL === `${SHIM_URL}/claude`
        } else {
          const command = await processCommand(pid)
          usesShim = [LEGACY_CODEX_BASE, CODEX_BASE].some((base) => command.includes(base))
        }
        if (usesShim) consumers.add(pid)
      }
    }
    return [...consumers]
  } catch {
    // If inspection fails, keeping a harmless direct pipe is safer than
    // stranding a session that captured its endpoint at launch.
    return null
  }
}

function scheduleDeferredRemoval(): void {
  if (cleanupTimer) return
  cleanupTimer = setTimeout(async () => {
    cleanupTimer = null
    const consumers = await liveShimConsumers()
    if (consumers === null || consumers.length > 0) scheduleDeferredRemoval()
    else await uninstallShim()
  }, 5_000)
  cleanupTimer.unref()
}

/**
 * Stop the helper only when no live CLI still points at it. Removing the
 * config changes future processes, but a running process keeps its launch
 * environment and would otherwise hit a dead port on its next request.
 */
export async function removeShim(): Promise<{ status: ShimStatus; retainedFor: number }> {
  const consumers = await liveShimConsumers()
  if (consumers === null || consumers.length > 0) {
    mkdirSync(RUNTIME_DIR, { recursive: true, mode: 0o700 })
    writeFileSync(REMOVE_PENDING_PATH, '')
    scheduleDeferredRemoval()
    return { status: await shimStatus(), retainedFor: consumers?.length ?? 1 }
  }
  return { status: await uninstallShim(), retainedFor: 0 }
}

/** Resume a safe deferred uninstall after Aliax itself restarts. */
export async function resumePendingRemoval(): Promise<void> {
  if (!existsSync(REMOVE_PENDING_PATH)) return
  const consumers = await liveShimConsumers()
  if (consumers !== null && consumers.length === 0) await uninstallShim()
  else scheduleDeferredRemoval()
}

/**
 * Reinstall the helper when this build ships a different script than the one
 * running, so a shim fix reaches users on their next launch instead of waiting
 * for them to turn instant switching off and on. Skipped when the helper is
 * not installed or is on its way out.
 */
export async function refreshShim(): Promise<void> {
  if (!existsSync(PLIST_PATH) || existsSync(REMOVE_PENDING_PATH) || !existsSync(SCRIPT_PATH)) return
  if (readFileSync(SCRIPT_PATH, 'utf8') === readFileSync(sourceScript(), 'utf8')) return
  await installShim()
}

// --- CLI config: the part that reaches GUI-launched sessions ---

const CLAUDE_SETTINGS = join(homedir(), '.claude', 'settings.json')
const CODEX_CONFIG = join(homedir(), '.codex', 'config.toml')
const TOML_MARK = '# aliax: instant switching'

/** Point Claude Code at the shim via its settings `env` block. */
function writeClaudeConfig(url: string | null): void {
  if (!existsSync(CLAUDE_SETTINGS)) return
  let settings: Record<string, unknown>
  try {
    settings = JSON.parse(readFileSync(CLAUDE_SETTINGS, 'utf8'))
  } catch {
    return
  }
  const env = { ...((settings.env as Record<string, string>) ?? {}) }
  if (url) {
    const target = `${url}/claude`
    if (env.ANTHROPIC_BASE_URL && env.ANTHROPIC_BASE_URL !== target) {
      throw new Error('Claude Code already has a custom ANTHROPIC_BASE_URL; Aliax left it unchanged')
    }
    env.ANTHROPIC_BASE_URL = target
  } else if (env.ANTHROPIC_BASE_URL === `${SHIM_URL}/claude`) {
    delete env.ANTHROPIC_BASE_URL
  }
  if (Object.keys(env).length > 0) settings.env = env
  else delete settings.env
  writeFileSync(CLAUDE_SETTINGS, `${JSON.stringify(settings, null, 2)}\n`)
}

/** A `chatgpt_base_url` line Aliax wrote: the TLS base, or the plain one it replaces. */
const isAliaxCodexLine = (line: string | undefined): boolean =>
  [LEGACY_CODEX_BASE, CODEX_BASE].some((base) => line?.trim() === `chatgpt_base_url = "${base}"`)

/** Same for Codex, whose base URL is a top-level config key. */
function writeCodexConfig(enabled: boolean): void {
  if (!existsSync(CODEX_CONFIG)) return
  const lines = readFileSync(CODEX_CONFIG, 'utf8').split('\n')
  if (enabled) {
    const existing = lines.find((line) => line.trimStart().startsWith('chatgpt_base_url'))
    if (existing && !isAliaxCodexLine(existing)) {
      throw new Error('Codex already has a custom chatgpt_base_url; Aliax left it unchanged')
    }
    if (existing?.trim() === `chatgpt_base_url = "${CODEX_BASE}"`) return
  }
  const kept: string[] = []
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === TOML_MARK) {
      if (isAliaxCodexLine(lines[i + 1])) i++
      continue
    }
    kept.push(lines[i])
  }
  if (enabled) {
    // Top-level keys must precede the first [table] header.
    const firstTable = kept.findIndex((l) => l.trimStart().startsWith('['))
    const at = firstTable === -1 ? kept.length : firstTable
    kept.splice(at, 0, TOML_MARK, `chatgpt_base_url = "${CODEX_BASE}"`, '')
  }
  writeFileSync(CODEX_CONFIG, kept.join('\n'))
}

/** Refuse to replace endpoints owned by the user or another tool. */
export function assertCliConfigWritable(): void {
  if (existsSync(CLAUDE_SETTINGS)) {
    try {
      const settings = JSON.parse(readFileSync(CLAUDE_SETTINGS, 'utf8'))
      const existing = settings?.env?.ANTHROPIC_BASE_URL
      if (existing && existing !== `${SHIM_URL}/claude`) {
        throw new Error('Claude Code already has a custom ANTHROPIC_BASE_URL; Aliax left it unchanged')
      }
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error('Claude Code settings.json is not valid JSON; Aliax left it unchanged')
      }
      throw error
    }
  }
  if (existsSync(CODEX_CONFIG)) {
    const existing = readFileSync(CODEX_CONFIG, 'utf8')
      .split('\n')
      .find((line) => line.trimStart().startsWith('chatgpt_base_url'))
    if (existing && !isAliaxCodexLine(existing)) {
      throw new Error('Codex already has a custom chatgpt_base_url; Aliax left it unchanged')
    }
  }
}

export function writeCliConfig(enabled: boolean): void {
  if (enabled) assertCliConfigWritable()
  writeClaudeConfig(enabled ? SHIM_URL : null)
  writeCodexConfig(enabled)
}

export function cliConfigInstalled(): boolean {
  try {
    const settings = JSON.parse(readFileSync(CLAUDE_SETTINGS, 'utf8'))
    return settings?.env?.ANTHROPIC_BASE_URL === `${SHIM_URL}/claude`
  } catch {
    return false
  }
}
