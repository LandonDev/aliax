import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import {
  claim,
  fail,
  forward,
  handleControl,
  isLive,
  pinnedProfile,
  readMarker,
  release,
  watchMarker,
  type Owner,
  type ProxyStatus,
  type Role
} from 'aliax-core'

export { pinProfile, RUNTIME_DIR } from 'aliax-core'
import { broadcast } from './events'

/**
 * A localhost gateway that swaps the Authorization header on every CLI request
 * for the account Aliax currently has selected. Running sessions therefore
 * follow a switch without being killed — the credential is resolved per request
 * rather than read once at startup.
 *
 * The forwarding itself lives in aliax-core (`forward`), shared with temp-code.
 * This file owns the server, the counters and the marker: whichever app holds
 * `~/.aliax/proxy.json` is what the shim routes to. Aliax never takes the
 * marker from a live foreign owner; it serves in standby until that owner
 * goes away.
 */
const OWNER: Owner = 'aliax'

let server: Server | null = null
let port = 0
let lastError: string | null = null
let standby: Owner | null = null
let stopWatching: (() => void) | null = null
const routed: Record<string, number> = {}

/** Standby only reads the shared cache and never refreshes stored tokens. */
export const role = (): Role => (standby ? 'standby' : 'owner')

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (await handleControl(req, res, OWNER)) return
  const out = await forward(req, res, { onError: (m) => (lastError = m) })
  if (out.status !== null) routed[out.service] = (routed[out.service] ?? 0) + 1
}

/**
 * Take the marker unless a live gateway holds it. A foreign owner always keeps
 * it (rule 1). Another copy of Aliax keeps it too, except at startup: a fresh
 * copy takes over, so a dev run beside the installed app gets the shim and
 * hands it back on quit. Without that, two copies would reclaim in turns
 * forever. Returns whether we own the shim now.
 */
export function claimIfFree(takeOver = false): boolean {
  if (!server) return false
  const current = readMarker()
  const was = standby
  if (isLive(current) && current.pid !== process.pid && (current.owner !== OWNER || !takeOver)) {
    standby = current.owner
  } else {
    standby = null
    // Our own live marker needs no rewrite; that would only wake other watchers.
    if (current?.pid !== process.pid || current.port !== port) claim(OWNER, port)
  }
  // The window shows who routes, and the tray's numbers come from a cache the
  // owner writes, so a flip either way is worth a redraw.
  if (was !== standby) broadcast('accounts:changed')
  return standby === null
}

export async function startProxy(): Promise<ProxyStatus> {
  if (server) return status()
  lastError = null
  server = createServer((req, res) => {
    handle(req, res).catch((e) => {
      lastError = (e as Error).message
      fail(res, 500, lastError)
    })
  })
  // Long model turns must not be cut off by an idle timer.
  server.requestTimeout = 0
  server.headersTimeout = 0
  server.setTimeout(0)

  await new Promise<void>((resolve, reject) => {
    server?.once('error', reject)
    // Loopback only: never reachable from the network.
    server?.listen(0, '127.0.0.1', resolve)
  }).catch((e) => {
    server = null
    lastError = (e as Error).message
    throw e
  })

  const address = server.address()
  port = typeof address === 'object' && address ? address.port : 0
  claimIfFree(true)
  // Rule 4: notice a foreign owner arriving or leaving, and a dead one on the tick.
  stopWatching = watchMarker(() => claimIfFree())
  return status()
}

export async function stopProxy(): Promise<ProxyStatus> {
  stopWatching?.()
  stopWatching = null
  clearRuntimeFile()
  const current = server
  server = null
  port = 0
  standby = null
  if (current) {
    await new Promise<void>((resolve) => current.close(() => resolve()))
    current.closeAllConnections?.()
  }
  return status()
}

/** Give the marker back (only ever our own), so a dead port is never routed to. */
export function clearRuntimeFile(): void {
  try {
    release(OWNER)
  } catch {
    // a stuck marker only means shells will not route; not fatal on the way out
  }
}

export function status(): ProxyStatus {
  return {
    running: server !== null,
    port,
    claudeBaseUrl: server ? `http://127.0.0.1:${port}/claude` : null,
    codexBaseUrl: server ? `http://127.0.0.1:${port}/codex` : null,
    routed: { ...routed },
    accounts: {
      'claude-code': pinnedProfile('claude-code'),
      codex: pinnedProfile('codex')
    },
    standby,
    error: lastError
  }
}
