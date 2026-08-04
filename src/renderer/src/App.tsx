import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowDownToLine, ChartNoAxesColumn, PictureInPicture2, RefreshCw, Settings, UsersRound } from 'lucide-react'
import { motion, useReducedMotion } from 'motion/react'
import { toast } from 'sonner'
import type { ProxyStatus, ServiceId, ServiceView, UpdateStatus, UsageReport, WindowMode } from '../../shared/types'
import { Loader } from '@/components/motion/loader'
import { Tabs, TabsList, TabsTrigger } from '@/components/motion/tabs'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Toaster } from '@/components/ui/sonner'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { EASE_OUT } from '@/lib/ease'
import { cn } from '@/lib/utils'
import { AccountsView, SectionSkeleton } from '@/views/accounts'
import { MiniView } from '@/views/mini'
import { ProxyBar } from '@/views/proxy-bar'
import { ProxyDialog } from '@/views/proxy-dialog'
import { SettingsDialog } from '@/views/settings-dialog'
import { StatsView } from '@/views/stats'

type Tab = 'accounts' | 'stats'

const TABS = [
  { id: 'accounts', label: 'Accounts', icon: UsersRound },
  { id: 'stats', label: 'Stats', icon: ChartNoAxesColumn }
] as const

/**
 * The update pill: absent until a release exists, then one button that walks
 * available → downloading → restart. No modal, no badge elsewhere — the title
 * bar is where app-level state lives.
 */
function UpdateButton() {
  const [status, setStatus] = useState<UpdateStatus>({ state: 'idle' })

  useEffect(() => {
    window.aliax.updateStatus().then(setStatus)
    return window.aliax.onUpdateChanged(setStatus)
  }, [])

  if (status.state === 'idle') return null
  if (status.state === 'error') {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1.5 px-2.5 text-[12px] text-warning [-webkit-app-region:no-drag]"
            onClick={() => window.aliax.updateDownload()}
          >
            Update failed. Retry
          </Button>
        </TooltipTrigger>
        <TooltipContent>{status.error}</TooltipContent>
      </Tooltip>
    )
  }
  const label =
    status.state === 'available'
      ? `Update to ${status.version}`
      : status.state === 'downloading'
        ? `Downloading… ${status.percent ?? 0}%`
        : 'Restart to update'
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={status.state === 'downloading'}
      className="h-7 gap-1.5 border-primary/25 px-2.5 text-[12px] [-webkit-app-region:no-drag]"
      onClick={() =>
        status.state === 'available' ? window.aliax.updateDownload() : window.aliax.updateInstall()
      }
    >
      <ArrowDownToLine className="size-3.5" />
      {label}
    </Button>
  )
}

function TitleBarButton({
  label,
  onClick,
  children
}: {
  label: string
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={label}
          className="text-muted-foreground hover:text-foreground"
          onClick={onClick}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

export default function App() {
  const [views, setViews] = useState<ServiceView[] | null>(null)
  const [usage, setUsage] = useState<Partial<Record<ServiceId, UsageReport[]>>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [tab, setTab] = useState<Tab>('accounts')
  const [mode, setMode] = useState<WindowMode>('normal')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [loginPromptOpen, setLoginPromptOpen] = useState(false)
  const [proxyOpen, setProxyOpen] = useState(false)
  const [proxy, setProxy] = useState<ProxyStatus | null>(null)
  const [loginService, setLoginService] = useState<ServiceId | null>(null)
  const reduce = useReducedMotion()

  const refreshUsage = useCallback((services: ServiceView[], force = false) => {
    const active = services.filter((s) => s.installed && s.profiles.length > 0)
    // A manual refresh drops the bars to skeletons so the reload is visible;
    // the background poll updates in place without the flash.
    if (force) {
      setUsage((u) => {
        const next = { ...u }
        for (const s of active) delete next[s.id]
        return next
      })
    }
    const jobs = active.map((s) =>
      window.aliax.usage(s.id, force).then((reports) => setUsage((u) => ({ ...u, [s.id]: reports })))
    )
    return Promise.all(jobs)
  }, [])

  const lastRefresh = useRef(0)
  const refresh = useCallback(
    async (force = false) => {
      if (!force && Date.now() - lastRefresh.current < 15_000) return
      lastRefresh.current = Date.now()
      // The button forces a live poll of the provider APIs; the spinner stays
      // until every account has answered, not just until the list is fetched.
      if (force) setRefreshing(true)
      const services = await window.aliax.listServices()
      setViews(services)
      window.aliax.proxyStatus().then((s) => setProxy(s.proxy))
      await refreshUsage(services, force)
      setRefreshing(false)
    },
    [refreshUsage]
  )

  useEffect(() => {
    window.aliax.getSettings().then((s) => {
      setMode(s.windowMode)
      // First run only: Aliax is most useful sitting in the menu bar, so offer
      // that once rather than leaving it buried in Settings.
      if (!s.askedLaunchAtLogin) setLoginPromptOpen(true)
    })
    refresh(true)
    const interval = setInterval(() => refresh(), 5 * 60_000)
    const onFocus = () => refresh()
    window.addEventListener('focus', onFocus)
    // A switch made from the menu bar has to show up here immediately, not on
    // the next poll — otherwise it reads as if the switch never happened.
    const unsubscribe = window.aliax.onAccountsChanged(() => refresh(true))
    return () => {
      clearInterval(interval)
      window.removeEventListener('focus', onFocus)
      unsubscribe()
    }
  }, [refresh])

  const run = async (
    key: string,
    action: () => Promise<{ ok: boolean; error?: string; notes?: string[] }>,
    successFallback = 'Done'
  ) => {
    setBusy(key)
    const result = await action()
    setBusy(null)
    if (result.ok) toast.success(result.notes?.length ? result.notes.join(' · ') : successFallback)
    else toast.error(result.error ?? 'Something went wrong')
    await refresh(true)
  }

  const onUse = (serviceId: ServiceId, name: string) =>
    run(`use:${serviceId}:${name}`, () => window.aliax.activate(serviceId, name), 'Switched')

  /** Adding never switches. Offer the switch as the next step instead. */
  const addAccount = async (serviceId: ServiceId) => {
    setLoginService(serviceId)
    const result = await window.aliax.loginStart(serviceId)
    setLoginService(null)
    if (!result.ok) {
      toast.error(result.error ?? 'Sign-in failed')
    } else {
      const added = result.name ? `Added ${result.name}` : 'Account added'
      toast.success(result.notes?.length ? `${added} · ${result.notes.join(' · ')}` : added, {
        action: result.name
          ? { label: 'Switch to it', onClick: () => onUse(serviceId, result.name as string) }
          : undefined
      })
    }
    await refresh(true)
  }

  const cancelLogin = () => {
    if (!loginService) return
    window.aliax.loginCancel(loginService)
    setLoginService(null)
  }

  /** Answering either way retires the prompt, so it is asked exactly once. */
  const answerLoginPrompt = async (enable: boolean) => {
    setLoginPromptOpen(false)
    const settings = await window.aliax.getSettings()
    await window.aliax.setSettings({ ...settings, launchAtLogin: enable, askedLaunchAtLogin: true })
    if (enable) toast.success('Aliax will open at login')
  }

  const toggleMode = () => {
    const next: WindowMode = mode === 'normal' ? 'mini' : 'normal'
    setMode(next)
    if (next === 'mini') setTab('accounts')
    window.aliax.setWindowMode(next)
  }

  const mini = mode === 'mini'
  const loginName = views?.find((v) => v.id === loginService)?.name ?? ''

  return (
    <TooltipProvider delayDuration={400}>
      <div className="flex h-full flex-col">
        <header
          className={cn(
            'relative z-10 flex shrink-0 items-center gap-4 border-b border-border/70 bg-background/80 backdrop-blur [-webkit-app-region:drag]',
            mini ? 'h-11 pr-2 pl-[4.5rem]' : 'h-[3.25rem] pr-3 pl-20'
          )}
        >
          {!mini && (
            <nav className="absolute left-1/2 -translate-x-1/2 [-webkit-app-region:no-drag]">
              <Tabs
                variant="segment"
                value={tab}
                onValueChange={(v) => setTab(v as Tab)}
                className="inline-flex"
              >
                <TabsList className="h-8 bg-card p-0.5">
                  {TABS.map((t) => (
                    <TabsTrigger
                      key={t.id}
                      value={t.id}
                      // The indicator is a quiet raised chip, so the active
                      // label has to stay light rather than flip to dark.
                      className="h-7 gap-1.5 rounded-md px-3 text-[13px] aria-selected:text-foreground"
                      indicatorClassName="rounded-md bg-elevated shadow-[inset_0_1px_0_0_oklch(1_0_0/8%)]"
                    >
                      <t.icon className="size-3.5" />
                      {t.label}
                    </TabsTrigger>
                  ))}
                </TabsList>
              </Tabs>
            </nav>
          )}

          <div className="ml-auto flex items-center gap-0.5 [-webkit-app-region:no-drag]">
            {!mini && <UpdateButton />}
            {!mini && (
              <>
                <TitleBarButton label="Refresh" onClick={() => refresh(true)}>
                  <RefreshCw className={cn(refreshing && 'animate-spin')} />
                </TitleBarButton>
                <TitleBarButton label="Settings" onClick={() => setSettingsOpen(true)}>
                  <Settings />
                </TitleBarButton>
              </>
            )}
            <TitleBarButton label={mini ? 'Full window' : 'Mini window'} onClick={toggleMode}>
              <PictureInPicture2 />
            </TitleBarButton>
          </div>
        </header>

        <main className={cn('flex-1 overflow-y-auto', mini ? 'px-3 py-3' : 'pt-8')}>
          <motion.div
            key={`${mode}-${tab}`}
            initial={reduce ? false : { opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.22, ease: EASE_OUT }}
            className={mini ? '' : 'mx-auto flex h-full w-full max-w-[62rem] flex-col px-8 pb-24'}
          >
            {views === null ? (
              !mini && (
                <div className="space-y-4">
                  <SectionSkeleton />
                  <SectionSkeleton />
                  <SectionSkeleton />
                </div>
              )
            ) : mini ? (
              <MiniView views={views} usage={usage} busy={busy} onUse={onUse} />
            ) : tab === 'accounts' ? (
              <div className="space-y-4">
                <ProxyBar
                  proxy={proxy}
                  onOpen={() => setProxyOpen(true)}
                  onChanged={() => refresh(true)}
                />
                <AccountsView
                views={views}
                usage={usage}
                busy={busy}
                onCapture={(id) => run(`capture:${id}`, () => window.aliax.capture(id), 'Saved')}
                onAdd={addAccount}
                onUse={onUse}
                onDelete={(id, name) =>
                  run(`use:${id}:${name}`, () => window.aliax.remove(id, name), 'Removed')
                }
                  onRefresh={() => refresh(true)}
                />
              </div>
            ) : (
              <StatsView usage={usage} services={views} />
            )}
          </motion.div>
        </main>

        <SettingsDialog
          open={settingsOpen}
          onOpenChange={setSettingsOpen}
          views={views ?? []}
        />
        <ProxyDialog
          open={proxyOpen}
          onOpenChange={setProxyOpen}
          onChanged={() => refresh(true)}
        />

        <Dialog open={loginPromptOpen} onOpenChange={(open) => !open && answerLoginPrompt(false)}>
          <DialogContent className="sm:max-w-sm" showCloseButton={false}>
            <DialogHeader>
              <DialogTitle>Open Aliax at login?</DialogTitle>
              <DialogDescription>
                It sits in the menu bar, a click from your accounts.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="ghost" onClick={() => answerLoginPrompt(false)}>
                Not now
              </Button>
              <Button onClick={() => answerLoginPrompt(true)}>Open at login</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <Dialog open={loginService !== null} onOpenChange={(open) => !open && cancelLogin()}>
          <DialogContent className="sm:max-w-sm" showCloseButton={false}>
            <DialogHeader>
              <DialogTitle>Sign in to {loginName}</DialogTitle>
              <DialogDescription>
                Finish signing in the window that opened. Saving does not switch to it.
              </DialogDescription>
            </DialogHeader>
            <div className="flex items-center gap-3 py-2 text-muted-foreground">
              <Loader variant="dots" size={20} />
              <span className="text-sm">Waiting for sign-in</span>
            </div>
            <DialogFooter>
              <Button variant="ghost" onClick={cancelLogin}>
                Cancel
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <Toaster position="bottom-right" />
      </div>
    </TooltipProvider>
  )
}
