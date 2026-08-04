import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ShellIntegration } from '../shared/types'
import { RUNTIME_DIR } from './proxy'

const SNIPPET_PATH = join(RUNTIME_DIR, 'shell.sh')
const BEGIN = '# >>> aliax >>>'
const END = '# <<< aliax <<<'

/**
 * The snippet sourced from the user's shell rc. Everything it does is guarded
 * on Aliax actually running: it reads the runtime marker, checks the recorded
 * pid is alive, and only then points the CLIs at the proxy. If Aliax is closed
 * — or crashed — the guard fails and both CLIs talk to their real endpoints
 * exactly as they did before, so the shell can never be left broken.
 */
const SNIPPET = `#!/bin/sh
# Written by Aliax. Routes Claude Code and Codex through Aliax's local proxy
# so switching accounts does not require killing running sessions.
# Safe by construction: with Aliax closed, nothing here takes effect.

aliax_proxy_url() {
  _aliax_file="$HOME/.aliax/proxy.json"
  [ -r "$_aliax_file" ] || return 1
  _aliax_pid=$(sed -n 's/.*"pid"[[:space:]]*:[[:space:]]*\\([0-9]*\\).*/\\1/p' "$_aliax_file")
  _aliax_url=$(sed -n 's/.*"url"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' "$_aliax_file")
  [ -n "$_aliax_pid" ] && [ -n "$_aliax_url" ] || return 1
  # Aliax must still be alive; a stale marker from a crash must not route.
  kill -0 "$_aliax_pid" 2>/dev/null || return 1
  printf '%s' "$_aliax_url"
}

# Claude Code reads its endpoint from the environment at startup, so this is
# resolved per shell. Sessions already running keep whatever they started with.
_aliax_url=$(aliax_proxy_url) && export ANTHROPIC_BASE_URL="$_aliax_url/claude"
unset _aliax_url

# Codex takes its endpoint from config, so wrap the command and pass it
# per invocation. This leaves ~/.codex/config.toml untouched.
codex() {
  _aliax_url=$(aliax_proxy_url)
  if [ -n "$_aliax_url" ]; then
    command codex -c chatgpt_base_url="\\"$_aliax_url/codex\\"" "$@"
  else
    command codex "$@"
  fi
}
`

/** Shell rc files we know how to edit, newest-shell first. */
function rcCandidates(): string[] {
  const shell = process.env.SHELL ?? ''
  const home = homedir()
  if (shell.includes('zsh')) return [join(home, '.zshrc')]
  if (shell.includes('bash')) return [join(home, '.bashrc'), join(home, '.bash_profile')]
  if (shell.includes('fish')) return [join(home, '.config/fish/config.fish')]
  return [join(home, '.zshrc')]
}

const sourceLine = (): string => `${BEGIN}\n[ -f "${SNIPPET_PATH}" ] && . "${SNIPPET_PATH}"\n${END}`

export function integrationStatus(): ShellIntegration {
  const rc = rcCandidates()[0]
  const installed =
    existsSync(SNIPPET_PATH) && existsSync(rc) && readFileSync(rc, 'utf8').includes(BEGIN)
  return {
    installed,
    rcPath: rc,
    snippetPath: SNIPPET_PATH,
    // fish cannot source a POSIX snippet; say so rather than writing something broken.
    supported: !rc.endsWith('config.fish')
  }
}

export function installIntegration(): ShellIntegration {
  const { rcPath, supported } = integrationStatus()
  if (!supported) throw new Error('fish is not supported. Use zsh or bash')
  mkdirSync(RUNTIME_DIR, { recursive: true, mode: 0o700 })
  writeFileSync(SNIPPET_PATH, SNIPPET, { mode: 0o700 })

  const existing = existsSync(rcPath) ? readFileSync(rcPath, 'utf8') : ''
  if (!existing.includes(BEGIN)) {
    const spacer = existing.length > 0 && !existing.endsWith('\n') ? '\n\n' : '\n'
    writeFileSync(rcPath, `${existing}${spacer}${sourceLine()}\n`)
  }
  return integrationStatus()
}

export function removeIntegration(): ShellIntegration {
  const { rcPath } = integrationStatus()
  if (existsSync(rcPath)) {
    const text = readFileSync(rcPath, 'utf8')
    const start = text.indexOf(BEGIN)
    const end = text.indexOf(END)
    if (start !== -1 && end !== -1) {
      const cleaned = `${text.slice(0, start)}${text.slice(end + END.length)}`.replace(/\n{3,}/g, '\n\n')
      writeFileSync(rcPath, cleaned)
    }
  }
  // Leave the snippet file: it is inert without the rc line, and keeping it
  // means an already-open shell that sourced it keeps working until it exits.
  return integrationStatus()
}
