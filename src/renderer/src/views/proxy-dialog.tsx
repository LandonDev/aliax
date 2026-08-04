import { useCallback, useEffect, useState } from 'react'
import { Check, CircleAlert, TerminalSquare, Zap } from 'lucide-react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { toast } from 'sonner'
import type { LiveSession, ProxyStatus, ShellIntegration, ShimStatus } from '../../../shared/types'
import { Loader } from '@/components/motion/loader'
import { Alert, AlertDescription } from '@/components/reui/alert'
import { IconTile } from '@/components/reui/icon-tile'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { EASE_OUT } from '@/lib/ease'
import { cn } from '@/lib/utils'

type Step = 'intro' | 'shell' | 'sessions' | 'done'

const STEPS: Step[] = ['intro', 'shell', 'sessions', 'done']

function StepDots({ step }: { step: Step }) {
  const index = STEPS.indexOf(step)
  return (
    <div className="flex items-center gap-1.5">
      {STEPS.map((s, i) => (
        <span
          key={s}
          className={cn(
            'h-1 rounded-full transition-all duration-300',
            i === index ? 'w-5 bg-foreground' : i < index ? 'w-1.5 bg-foreground/50' : 'w-1.5 bg-white/15'
          )}
        />
      ))}
    </div>
  )
}

function Row({ children }: { children: React.ReactNode }) {
  return <li className="flex gap-2.5 text-sm text-muted-foreground">{children}</li>
}

function Tick() {
  return <Check className="mt-0.5 size-4 shrink-0 text-success" />
}

export function ProxyDialog({
  open,
  onOpenChange,
  onChanged
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onChanged: () => void
}) {
  const [step, setStep] = useState<Step>('intro')
  const [proxy, setProxy] = useState<ProxyStatus | null>(null)
  const [shell, setShell] = useState<ShellIntegration | null>(null)
  const [shim, setShim] = useState<ShimStatus | null>(null)
  const [sessions, setSessions] = useState<LiveSession[] | null>(null)
  const [busy, setBusy] = useState(false)
  const reduce = useReducedMotion()

  const load = useCallback(async () => {
    const s = await window.aliax.proxyStatus()
    setProxy(s.proxy)
    setShell(s.shell)
    setShim(s.shim)
    return s
  }, [])

  useEffect(() => {
    if (!open) return
    setBusy(false)
    load().then((s) => setStep(s.proxy.running && s.shim.installed ? 'done' : 'intro'))
  }, [open, load])

  useEffect(() => {
    if (!open || step !== 'sessions') return
    window.aliax.proxySessions().then(setSessions)
  }, [open, step])

  const enable = async () => {
    setBusy(true)
    const result = await window.aliax.proxySetEnabled(true)
    if (!result.ok) toast.error(result.error ?? 'Could not start the gateway')
    await load()
    setBusy(false)
    if (result.ok) setStep('shell')
    onChanged()
  }

  const installShell = async () => {
    setBusy(true)
    const result = await window.aliax.proxyInstallShell()
    await load()
    setBusy(false)
    if (result.ok) setStep('sessions')
    else toast.error(result.error ?? 'Could not write the shell snippet')
  }

  const adopt = async () => {
    setBusy(true)
    const result = await window.aliax.proxyAdopt()
    setBusy(false)
    if (result.ok) toast.success(result.notes?.join(' · ') ?? 'Sessions moved')
    else toast.error(result.error ?? 'Could not move sessions')
    setStep('done')
  }

  const turnOff = async () => {
    setBusy(true)
    await window.aliax.proxySetEnabled(false)
    const result = await window.aliax.proxyRemoveShell()
    await load()
    setBusy(false)
    onChanged()
    toast.success(result.ok && result.notes?.length ? result.notes.join(' · ') : 'Instant switching turned off')
    onOpenChange(false)
  }

  const stale = sessions?.filter((s) => !s.proxied) ?? []

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={step}
            initial={reduce ? false : { opacity: 0, x: 8 }}
            animate={{ opacity: 1, x: 0 }}
            exit={reduce ? undefined : { opacity: 0, x: -8 }}
            transition={{ duration: 0.2, ease: EASE_OUT }}
            className="grid gap-5"
          >
            {step === 'intro' && (
              <>
                <DialogHeader>
                  <IconTile variant="frame" size="lg" className="mb-1 text-foreground">
                    <Zap />
                  </IconTile>
                  <DialogTitle>Instant switching</DialogTitle>
                  <DialogDescription>Switch accounts without restarting your sessions.</DialogDescription>
                </DialogHeader>
                <ul className="grid gap-2.5">
                  <Row>
                    <Tick />
                    Claude Code and Codex send requests through Aliax, which attaches the account you
                    picked.
                  </Row>
                  <Row>
                    <Tick />
                    A switch lands on the next message, in every open session.
                  </Row>
                  <Row>
                    <Tick />
                    Works in editors too, not just terminals.
                  </Row>
                  <Row>
                    <Tick />
                    Nothing breaks when Aliax is closed.
                  </Row>
                </ul>
              </>
            )}

            {step === 'shell' && (
              <>
                <DialogHeader>
                  <DialogTitle>Set up your machine</DialogTitle>
                  <DialogDescription>
                    Aliax installs a background helper and adds one line to{' '}
                    {shell?.rcPath.replace(/^.*\//, '') ?? 'your shell file'}. You can remove both
                    here later.
                  </DialogDescription>
                </DialogHeader>
                {shell?.supported === false ? (
                  <Alert variant="warning">
                    <CircleAlert />
                    <AlertDescription>Instant switching needs zsh or bash.</AlertDescription>
                  </Alert>
                ) : (
                  <div className="rounded-lg bg-background/60 p-3 font-mono text-[11px] leading-relaxed text-muted-foreground">
                    <div className="text-muted-foreground/60"># {shell?.rcPath}</div>
                    <div>[ -f ~/.aliax/shell.sh ] &amp;&amp; . ~/.aliax/shell.sh</div>
                  </div>
                )}
                <p className="text-xs text-muted-foreground/70">
                  Programs pick this up on their next session.
                </p>
              </>
            )}

            {step === 'sessions' && (
              <>
                <DialogHeader>
                  <DialogTitle>Sessions open right now</DialogTitle>
                  <DialogDescription>
                    Sessions started earlier are not covered yet. Aliax can resume them in the same
                    tab, keeping the thread.
                  </DialogDescription>
                </DialogHeader>
                {sessions === null ? (
                  <div className="flex items-center gap-2.5 py-1 text-sm text-muted-foreground">
                    <Loader variant="spinner" size={16} /> Looking for running sessions
                  </div>
                ) : stale.length === 0 ? (
                  <div className="flex items-center gap-2.5 py-1 text-sm text-muted-foreground">
                    <Check className="size-4 text-success" />
                    Nothing to move. New sessions are covered automatically.
                  </div>
                ) : (
                  <ul className="grid gap-1.5">
                    {stale.map((s) => (
                      <li
                        key={`${s.serviceId}-${s.pid}`}
                        className="flex items-center gap-2 rounded-md bg-background/60 px-2.5 py-2 text-xs"
                      >
                        <TerminalSquare className="size-3.5 shrink-0 text-muted-foreground" />
                        <span className="truncate text-muted-foreground">
                          {s.cwd?.replace(/^.*\//, '') ?? 'unknown folder'}
                        </span>
                        <span className="ml-auto shrink-0 text-muted-foreground/60">
                          {s.serviceId === 'claude-code' ? 'Claude' : 'Codex'}
                          {s.tty ? '' : ' · no window found'}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}

            {step === 'done' && (
              <>
                <DialogHeader>
                  <IconTile variant="frame" size="lg" className="mb-1 text-success">
                    <Check />
                  </IconTile>
                  <DialogTitle>Instant switching is on</DialogTitle>
                  <DialogDescription>
                    Switches now land in every open session, with no restarts.
                  </DialogDescription>
                </DialogHeader>
                <div className="grid gap-2 rounded-lg bg-background/60 p-3 text-xs">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Gateway</span>
                    <span className={proxy?.running ? 'text-success' : 'text-destructive'}>
                      {proxy?.running ? `running on port ${proxy.port}` : 'stopped'}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Helper</span>
                    <span className={shim?.running ? 'text-success' : 'text-warning'}>
                      {shim?.running ? `running on port ${shim.port}` : 'not running'}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Programs covered</span>
                    <span className={shim?.installed ? 'text-success' : 'text-warning'}>
                      {shim?.installed ? 'all' : shell?.installed ? 'terminal only' : 'none'}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Requests routed</span>
                    <span className="text-muted-foreground">
                      {Object.values(proxy?.routed ?? {}).reduce((a, b) => a + b, 0)}
                    </span>
                  </div>
                </div>
                {proxy?.error && (
                  <Alert variant="warning">
                    <CircleAlert />
                    <AlertDescription>Last error: {proxy.error}</AlertDescription>
                  </Alert>
                )}
              </>
            )}

            <DialogFooter className="items-center sm:justify-between">
              <StepDots step={step} />
              <div className="flex items-center gap-2">
                {step === 'intro' && (
                  <Button onClick={enable} disabled={busy}>
                    {busy ? 'Starting…' : 'Turn on'}
                  </Button>
                )}
                {step === 'shell' && (
                  <>
                    <Button variant="ghost" onClick={() => setStep('sessions')}>
                      Skip
                    </Button>
                    <Button onClick={installShell} disabled={busy}>
                      {busy ? 'Installing…' : 'Install'}
                    </Button>
                  </>
                )}
                {step === 'sessions' && (
                  <>
                    <Button variant="ghost" onClick={() => setStep('done')}>
                      Later
                    </Button>
                    <Button onClick={adopt} disabled={busy || stale.length === 0}>
                      {busy ? 'Moving…' : `Move ${stale.length || ''}`.trim()}
                    </Button>
                  </>
                )}
                {step === 'done' && (
                  <>
                    <Button variant="ghost" onClick={turnOff} disabled={busy}>
                      Turn off
                    </Button>
                    <Button onClick={() => onOpenChange(false)}>Done</Button>
                  </>
                )}
              </div>
            </DialogFooter>
          </motion.div>
        </AnimatePresence>
      </DialogContent>
    </Dialog>
  )
}
