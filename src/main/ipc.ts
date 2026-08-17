import { ipcMain, shell } from 'electron'
import { existsSync, renameSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ActionResult, ServiceId, Settings, WindowMode } from '../shared/types'
import * as accounts from './accounts'
import { adapter } from './adapters'
import { applyWindowMode } from './index'
import * as login from './login'
import * as proxy from './proxy'
import { adoptSessions, liveSessions } from './sessions'
import * as shellIntegration from './shell-integration'
import * as shim from './shim'
import { indexAll, indexProgress } from './stats/indexer'
import { bundle, invalidate } from './stats/queries'
import { getSettings, saveSettings } from './settings'
import { refreshTray, setLaunchAtLogin } from './tray'
import { downloadUpdate, installUpdate, updateStatus } from './updater'
import * as vault from './vault'

const asResult = async (fn: () => Promise<ActionResult>): Promise<ActionResult> => {
  try {
    return await fn()
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

/**
 * Sign in and store the new account WITHOUT making it live. Adding is a
 * library action; switching stays an explicit, separate choice.
 */
async function loginStart(serviceId: ServiceId, loginHint?: string): Promise<ActionResult> {
  switch (serviceId) {
    case 'claude-code': {
      // One window: signing in gives us the app session, approving gives us the
      // CLI tokens. Both halves, no code to paste. A hint pre-fills the address
      // when an expired account signs itself back in.
      const captured = await login.claudeSignIn(loginHint)
      if (!captured) return { ok: false, error: 'sign-in cancelled' }
      const already = vault.profiles(serviceId).find((p) => p.accountId === captured.accountId)
      // A full sign-in always carries credentials, so this never skips.
      const name = accounts.saveCaptured(serviceId, captured) ?? undefined
      // A token can be revoked ahead of its recorded expiry, where only the
      // failed poll knows the sign-in is dead — read that flag before the
      // cache clear strips it.
      const wasExpired = name ? accounts.reportedExpired(serviceId, name) : false
      accounts.clearUsageCache(serviceId, name)
      const notes = [
        captured.note ?? '',
        already ? 'this account was already saved, so it was refreshed' : ''
      ].filter(Boolean)
      // Re-signing the account the CLI is already on, while its sign-in is dead
      // (token past expiry, or revoked early per the last poll): install the
      // fresh credentials too. The account does not change, so this is a
      // repair, not a switch (invariant 6) — and without it the new tokens are
      // stranded, because the active row offers no Switch button.
      const a = adapter(serviceId)
      const liveId = await a.liveAccountId().catch(() => null)
      if (
        name &&
        liveId === captured.accountId &&
        (wasExpired || (await a.liveCredentialExpired?.().catch(() => false)))
      ) {
        const repaired = await accounts.activate(serviceId, name)
        notes.push(
          repaired.ok
            ? 'CLI sign-in repaired'
            : `saved, but the CLI still holds a dead sign-in (${repaired.error})`
        )
      }
      return { ok: true, name, notes }
    }
    case 'cursor': {
      const captured = await login.cursorLogin()
      const name = accounts.saveCaptured(serviceId, captured) ?? undefined
      accounts.clearUsageCache(serviceId, name)
      return { ok: true, name }
    }
    case 'codex': {
      // The official `codex login` writes auth.json itself, so snapshot the current
      // login first and put it back afterwards to leave the live account untouched.
      const a = adapter(serviceId)
      await accounts.recaptureLive(a).catch(() => {})
      const previous = await a.capture(accounts.extra(serviceId, 'pre-login')).catch(() => null)
      // `codex login` REVOKES the grant sitting in auth.json before signing in
      // (the binary ships login/src/auth/revoke.rs and runs it as logout-first),
      // which is how adding account B used to kill saved account A. Move the
      // file out of its sight; the snapshot and the vault still hold the login.
      const authPath = join(homedir(), '.codex', 'auth.json')
      const stash = `${authPath}.aliax-prelogin`
      if (previous?.blob && existsSync(authPath)) renameSync(authPath, stash)
      try {
        await login.codexLogin()
        return await accounts.capture(serviceId)
      } finally {
        const liveId = await a.liveAccountId().catch(() => null)
        if (previous?.blob && liveId && liveId !== previous.accountId) {
          // Empty target set: write the old credentials back, restart nothing.
          await a
            .activate(previous.blob, accounts.extra(serviceId, 'pre-login'), new Set())
            .catch(() => {})
        } else if (!liveId && existsSync(stash)) {
          // Login failed or was cancelled: put the original file straight back.
          renameSync(stash, authPath)
        }
        // Re-adding the live account keeps the fresh grant instead of the old one.
        rmSync(stash, { force: true })
        accounts.clearUsageCache(serviceId)
      }
    }
  }
}

function loginCancel(serviceId: ServiceId): void {
  if (serviceId === 'claude-code') login.claudeLoginCancel()
  if (serviceId === 'cursor') login.cursorLoginCancel()
  if (serviceId === 'codex') login.codexLoginCancel()
}

export function registerIpc(): void {
  vault.ensureColors()
  accounts.watchLiveCredentials()
  // Pull in anything new from the CLIs' own logs. Incremental, so this is cheap
  // after the first run; the first run is thousands of files and runs detached.
  indexAll()
    .then(invalidate)
    .catch(() => {})
  // Relabel any profile whose stored credentials belong to a different account.
  for (const id of ['claude-code', 'codex', 'cursor'] as ServiceId[]) {
    accounts.repairProfiles(id).catch(() => {})
  }

  ipcMain.handle('services:list', () => accounts.listServices())
  ipcMain.handle('profiles:capture', (_e, serviceId: ServiceId) =>
    asResult(() => accounts.capture(serviceId))
  )
  ipcMain.handle('profiles:activate', (_e, serviceId: ServiceId, name: string) =>
    asResult(async () => {
      const result = await accounts.activate(serviceId, name)
      refreshTray()
      return result
    })
  )
  ipcMain.handle('profiles:delete', (_e, serviceId: ServiceId, name: string) =>
    asResult(async () => {
      vault.deleteProfile(serviceId, name)
      return { ok: true }
    })
  )
  ipcMain.handle('usage:get', (_e, serviceId: ServiceId, force?: boolean) =>
    accounts.usage(serviceId, force === true)
  )
  ipcMain.handle(
    'profiles:update',
    (_e, serviceId: ServiceId, name: string, patch: { nickname?: string; color?: string }) =>
      accounts.updateProfile(serviceId, name, patch)
  )
  ipcMain.handle('settings:get', () => getSettings())
  ipcMain.handle('settings:set', (_e, settings: Settings) => {
    const before = getSettings()
    saveSettings(settings)
    if (settings.launchAtLogin !== before.launchAtLogin) {
      setLaunchAtLogin(settings.launchAtLogin === true)
    }
    return { ok: true }
  })
  ipcMain.handle('ui:setMode', (_e, mode: WindowMode) => {
    applyWindowMode(mode)
    return { ok: true }
  })
  ipcMain.handle('login:start', (_e, serviceId: ServiceId, loginHint?: string) =>
    asResult(() => loginStart(serviceId, loginHint))
  )
  ipcMain.handle('login:cancel', (_e, serviceId: ServiceId) => loginCancel(serviceId))

  ipcMain.handle('proxy:status', async () => ({
    proxy: proxy.status(),
    shell: shellIntegration.integrationStatus(),
    shim: await shim.shimStatus()
  }))
  ipcMain.handle('proxy:installShell', () =>
    asResult(async () => {
      // The helper owns a stable port, so the CLIs' own config can point at it.
      // That is what reaches sessions inside editors, which never read a shell.
      shim.assertCliConfigWritable()
      const status = await shim.installShim()
      if (!status.running) throw new Error('the background helper is not running')
      shim.writeCliConfig(true)
      shellIntegration.installIntegration()
      return { ok: true, notes: ['helper installed', 'covers every program'] }
    })
  )
  ipcMain.handle('proxy:setEnabled', (_e, enabled: boolean) =>
    asResult(async () => {
      saveSettings({ ...getSettings(), proxyEnabled: enabled })
      if (enabled) {
        await proxy.startProxy()
        // Without a pinned account the proxy would fall back to whatever is on
        // disk; seed it from the live account so it is correct immediately.
        for (const id of ['claude-code', 'codex'] as ServiceId[]) {
          const active = (await accounts.listServices())
            .find((s) => s.id === id)
            ?.profiles.find((p) => p.active)
          if (active) proxy.pinProfile(id, active.name)
        }
      } else {
        await proxy.stopProxy()
      }
      return { ok: true }
    })
  )
  ipcMain.handle('proxy:removeShell', () =>
    asResult(async () => {
      shim.writeCliConfig(false)
      const { retainedFor } = await shim.removeShim()
      shellIntegration.removeIntegration()
      return {
        ok: true,
        notes: retainedFor
          ? [`helper kept alive for ${retainedFor} open session${retainedFor === 1 ? '' : 's'}`]
          : undefined
      }
    })
  )
  ipcMain.handle('open:external', (_e, url: string) => {
    // Only ever http(s): never hand an arbitrary scheme to the OS.
    if (/^https?:\/\//.test(url)) shell.openExternal(url)
  })
  ipcMain.handle('stats:get', () => bundle())
  ipcMain.handle('stats:status', () => {
    const p = indexProgress()
    return { indexing: p.running, filesDone: p.filesDone, filesTotal: p.filesTotal, rows: p.rows }
  })
  ipcMain.handle('stats:reindex', () =>
    asResult(async () => {
      await indexAll()
      invalidate()
      return { ok: true }
    })
  )

  ipcMain.handle('update:status', () => updateStatus())
  ipcMain.handle('update:download', () => downloadUpdate())
  ipcMain.handle('update:install', () => installUpdate())

  ipcMain.handle('proxy:sessions', () => liveSessions())
  ipcMain.handle('proxy:adopt', () =>
    asResult(async () => {
      const { moved, elsewhere, skipped } = await adoptSessions()
      const notes: string[] = []
      if (moved) notes.push(`${moved} resumed in place`)
      if (elsewhere) notes.push(`${elsewhere} reopened in a new Terminal window`)
      if (skipped) notes.push(`${skipped} left alone (no window found)`)
      return { ok: true, notes: notes.length ? notes : ['nothing to move'] }
    })
  )
}
