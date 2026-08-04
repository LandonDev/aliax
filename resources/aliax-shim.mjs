#!/usr/bin/env node
/**
 * Aliax shim — a stable endpoint the CLIs can point at forever.
 *
 * It owns one fixed port and does exactly one thing: forward each request to
 * Aliax's gateway when Aliax is running, and straight to the real provider when
 * it is not. That is what lets the endpoint live in ~/.claude/settings.json and
 * ~/.codex/config.toml, which is the only way to reach CLIs launched inside GUI
 * apps — they never read your shell config.
 *
 * It holds no credentials and makes no decisions. With Aliax closed it is a
 * plain pipe to the provider, so quitting or crashing Aliax can never break a
 * CLI. Installed and removed by Aliax; safe to kill at any time.
 */
import { createServer, request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const PORT = Number(process.env.ALIAX_SHIM_PORT ?? 8787)
const MARKER = join(homedir(), '.aliax', 'proxy.json')

const DIRECT = {
  claude: { host: 'api.anthropic.com', prefix: '' },
  // Matches the gateway's own path split; see the upstream note in proxy.ts.
  codex: { host: 'chatgpt.com', prefix: '/backend-api' },
  codexV1: { host: 'chatgpt.com', prefix: '/backend-api/codex' }
}

/** Aliax's gateway, but only while the process that wrote the marker is alive. */
function gateway() {
  try {
    const { port, pid } = JSON.parse(readFileSync(MARKER, 'utf8'))
    if (!port || !pid) return null
    process.kill(pid, 0) // throws when that pid is gone
    return port
  } catch {
    return null
  }
}

const server = createServer((req, res) => {
  const url = req.url ?? '/'
  const slash = url.indexOf('/', 1)
  const service = url.slice(1, slash === -1 ? undefined : slash)
  const rest = slash === -1 ? '' : url.slice(slash)

  if (service === '__shim') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, aliax: gateway() !== null }))
    return
  }
  if (service !== 'claude' && service !== 'codex') {
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { type: 'aliax_shim', message: `unknown service` } }))
    return
  }

  const headers = { ...req.headers }
  const port = gateway()
  let upstream

  if (port) {
    // Aliax is up: hand the whole path over untouched and let it authenticate.
    headers.host = `127.0.0.1:${port}`
    upstream = httpRequest(
      { host: '127.0.0.1', port, path: url, method: req.method, headers },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers)
        up.pipe(res)
      }
    )
  } else {
    // Aliax is closed: a plain pipe to the provider, using whatever credential
    // the CLI already sent. Nothing here can make a request fail that would
    // otherwise have worked.
    const target =
      service === 'codex' && rest.startsWith('/v1/') ? DIRECT.codexV1 : DIRECT[service]
    headers.host = target.host
    upstream = httpsRequest(
      { host: target.host, port: 443, path: `${target.prefix}${rest}`, method: req.method, headers },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers)
        up.pipe(res)
      }
    )
  }

  upstream.on('error', (e) => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { type: 'aliax_shim', message: e.message } }))
  })
  req.pipe(upstream)
})

// Model turns run long; never time one out.
server.requestTimeout = 0
server.headersTimeout = 0
server.setTimeout(0)
server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`aliax-shim listening on 127.0.0.1:${PORT}\n`)
})
