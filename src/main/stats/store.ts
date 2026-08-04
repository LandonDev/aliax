import { app } from 'electron'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'

/**
 * Local analytics store. Everything here is derived from files already on this
 * machine (the CLIs' own session logs) plus Aliax's own usage polling, so it can
 * be deleted and rebuilt at any time.
 */
let db: DatabaseSync | null = null

export function open(): DatabaseSync {
  if (db) return db
  db = new DatabaseSync(join(app.getPath('userData'), 'stats.db'))
  db.exec(`
    PRAGMA journal_mode = WAL;

    -- One row per assistant turn. Tokens are the raw counters the CLI recorded.
    CREATE TABLE IF NOT EXISTS turns (
      id INTEGER PRIMARY KEY,
      service TEXT NOT NULL,
      ts INTEGER NOT NULL,
      session TEXT,
      project TEXT,
      branch TEXT,
      model TEXT,
      surface TEXT,          -- Claude 'entrypoint': cli / sdk-ts / claude-desktop / …
      effort TEXT,
      input INTEGER DEFAULT 0,
      output INTEGER DEFAULT 0,
      cache_read INTEGER DEFAULT 0,
      cache_write INTEGER DEFAULT 0,
      eph_1h INTEGER DEFAULT 0,
      eph_5m INTEGER DEFAULT 0,
      stop_reason TEXT
    );
    CREATE INDEX IF NOT EXISTS turns_ts ON turns(ts);
    CREATE INDEX IF NOT EXISTS turns_service_ts ON turns(service, ts);

    -- Tool invocations, one row each.
    CREATE TABLE IF NOT EXISTS tool_calls (
      id INTEGER PRIMARY KEY,
      service TEXT NOT NULL,
      ts INTEGER NOT NULL,
      session TEXT,
      name TEXT NOT NULL,
      kind TEXT              -- builtin | mcp | skill
    );
    CREATE INDEX IF NOT EXISTS tool_ts ON tool_calls(ts);

    -- Notable session events: compaction, aborted turn, limit hit.
    CREATE TABLE IF NOT EXISTS session_events (
      id INTEGER PRIMARY KEY,
      service TEXT NOT NULL,
      ts INTEGER NOT NULL,
      session TEXT,
      kind TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ev_ts ON session_events(ts);

    -- Rate-limit observations. Backfilled from Codex logs, appended by our polling.
    CREATE TABLE IF NOT EXISTS usage_samples (
      id INTEGER PRIMARY KEY,
      service TEXT NOT NULL,
      account TEXT,
      ts INTEGER NOT NULL,
      label TEXT NOT NULL,
      used_percent REAL NOT NULL,
      resets_at INTEGER,
      period_ms INTEGER
    );
    CREATE INDEX IF NOT EXISTS usage_ts ON usage_samples(service, label, ts);

    -- Aliax's own actions, so switch behaviour is measurable.
    CREATE TABLE IF NOT EXISTS app_events (
      id INTEGER PRIMARY KEY,
      ts INTEGER NOT NULL,
      kind TEXT NOT NULL,    -- switch | add | switch_failed | limit_hit
      service TEXT,
      account TEXT,
      detail TEXT
    );
    CREATE INDEX IF NOT EXISTS app_ts ON app_events(ts);

    -- How far each source file has been read, so indexing is incremental.
    CREATE TABLE IF NOT EXISTS files (
      path TEXT PRIMARY KEY,
      mtime INTEGER NOT NULL,
      size INTEGER NOT NULL,
      offset INTEGER NOT NULL
    );
  `)
  return db
}

export function recordAppEvent(
  kind: string,
  service?: string,
  account?: string,
  detail?: string
): void {
  try {
    open()
      .prepare('INSERT INTO app_events (ts, kind, service, account, detail) VALUES (?,?,?,?,?)')
      .run(Date.now(), kind, service ?? null, account ?? null, detail ?? null)
  } catch {
    // analytics must never break a switch
  }
}

/** Append a live usage reading. De-duplicated by (service, account, label, minute). */
export function recordUsage(
  service: string,
  account: string,
  label: string,
  usedPercent: number,
  resetsAt?: number,
  periodMs?: number
): void {
  try {
    const d = open()
    const minute = Math.floor(Date.now() / 60_000) * 60_000
    const dup = d
      .prepare(
        'SELECT 1 FROM usage_samples WHERE service=? AND account=? AND label=? AND ts=? LIMIT 1'
      )
      .get(service, account, label, minute)
    if (dup) return
    d.prepare(
      'INSERT INTO usage_samples (service, account, ts, label, used_percent, resets_at, period_ms) VALUES (?,?,?,?,?,?,?)'
    ).run(service, account, minute, label, usedPercent, resetsAt ?? null, periodMs ?? null)
  } catch {
    // ignore
  }
}
