import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { LiveSession, ServiceId } from '../shared/types'
import {
  cliProcesses,
  killAndWait,
  processCommand,
  reopenSession,
  routedThroughAliax,
  terminalOwns,
  type CliProcess
} from './procs'
import { status as proxyStatus } from './proxy'
import { SHIM_PORT } from './shim'

const BINARY: Record<'claude-code' | 'codex', string> = { 'claude-code': 'claude', codex: 'codex' }

/** Newest Claude session id recorded for a working directory. */
function latestClaudeSession(cwd: string): string | null {
  const dir = join(homedir(), '.claude', 'projects', cwd.replace(/[/.]/g, '-'))
  if (!existsSync(dir)) return null
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => ({ id: f.replace(/\.jsonl$/, ''), mtime: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
  return files[0]?.id ?? null
}

function readFirstLine(path: string): string {
  const text = readFileSync(path, 'utf8').slice(0, 8192)
  const nl = text.indexOf('\n')
  return nl === -1 ? text : text.slice(0, nl)
}

/** Newest Codex session id recorded for a working directory. */
function latestCodexSession(cwd: string): string | null {
  const root = join(homedir(), '.codex', 'sessions')
  if (!existsSync(root)) return null
  const files: { path: string; mtime: number }[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name)
      if (entry.isDirectory()) walk(p)
      else if (entry.name.endsWith('.jsonl')) files.push({ path: p, mtime: statSync(p).mtimeMs })
    }
  }
  walk(root)
  files.sort((a, b) => b.mtime - a.mtime)
  for (const f of files.slice(0, 30)) {
    try {
      const meta = JSON.parse(readFirstLine(f.path)).payload
      if (meta?.cwd === cwd) return meta.id ?? meta.session_id ?? null
    } catch {
      // not a meta line
    }
  }
  return null
}

const resumeCommand = (serviceId: ServiceId, cwd: string | null): string => {
  if (serviceId === 'claude-code') {
    const id = cwd ? latestClaudeSession(cwd) : null
    return id ? `claude --resume ${id}` : 'claude --continue'
  }
  const id = cwd ? latestCodexSession(cwd) : null
  return id ? `codex resume ${id}` : 'codex'
}

/**
 * Terminal CLI sessions and whether each already routes through Aliax. A
 * session is proxied when it was launched with our base URL in its environment
 * (Claude) or on its command line (Codex) — read from the process itself, so a
 * shell that has since been reconfigured cannot make us claim a stale session
 * is covered.
 */
export async function liveSessions(): Promise<LiveSession[]> {
  const { port } = proxyStatus()
  const markers = [`127.0.0.1:${SHIM_PORT}`, ...(port > 0 ? [`127.0.0.1:${port}`] : [])]
  const out: LiveSession[] = []

  for (const serviceId of ['claude-code', 'codex'] as const) {
    const procs = await cliProcesses(BINARY[serviceId]).catch(() => [])
    for (const p of procs) {
      let proxied = false
      if (serviceId === 'claude-code') {
        // Not just the environment: Claude Code takes its base URL from
        // settings.json when that file names one, which is how every
        // GUI-launched session gets routed. Reading only the environment marked
        // all of those as uncovered.
        proxied = await routedThroughAliax(p.pid)
      } else {
        const command = await processCommand(p.pid)
        proxied = markers.some((marker) => command.includes(marker))
      }
      out.push({ serviceId, pid: p.pid, cwd: p.cwd, tty: p.tty, proxied })
    }
  }
  return out
}

/**
 * Move already-running sessions onto the proxy. They cannot adopt it in place —
 * the endpoint is fixed at launch — so each is restarted in the terminal tab it
 * already occupies, resuming the same thread. This is the one-time cost of
 * turning the feature on; afterwards switching never restarts anything.
 */
export async function adoptSessions(): Promise<{ moved: number; elsewhere: number; skipped: number }> {
  const { running, claudeBaseUrl, codexBaseUrl } = proxyStatus()
  if (!running) throw new Error('the Aliax proxy is not running')

  const targets = (await liveSessions()).filter((s) => !s.proxied)
  let moved = 0
  let elsewhere = 0
  let skipped = 0

  for (const s of targets) {
    // Only move a session we can put back in its own tab; never relocate one.
    if (!(await terminalOwns(s.tty))) {
      skipped++
      continue
    }
    const base = s.serviceId === 'claude-code' ? claudeBaseUrl : codexBaseUrl
    const resume = resumeCommand(s.serviceId, s.cwd)
    const command =
      s.serviceId === 'claude-code'
        ? `ANTHROPIC_BASE_URL='${base}' ${resume}`
        : resume.replace(/^codex/, `codex -c chatgpt_base_url='"${base}"'`)

    await killAndWait([s.pid])
    const proc: CliProcess = { pid: s.pid, cwd: s.cwd, tty: s.tty }
    if (await reopenSession(proc, command)) moved++
    else skipped++
  }
  return { moved, elsewhere, skipped }
}
