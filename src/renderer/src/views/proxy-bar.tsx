import { useState } from 'react'
import { Power, Zap } from 'lucide-react'
import { toast } from 'sonner'
import type { ProxyStatus } from '../../../shared/types'
import { Loader } from '@/components/motion/loader'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

/**
 * Always visible, and switchable from here.
 *
 * Turning it ON needs setup, so that opens the walkthrough. Turning it OFF is a
 * single click with no detour — the thing you reach for when something is going
 * wrong is the thing that should take one action.
 */
export function ProxyBar({
  proxy,
  onOpen,
  onChanged
}: {
  proxy: ProxyStatus | null
  onOpen: () => void
  onChanged: () => void
}) {
  const [busy, setBusy] = useState(false)
  const on = proxy?.running ?? false
  const routed = Object.values(proxy?.routed ?? {}).reduce((a, b) => a + b, 0)

  const turnOff = async () => {
    setBusy(true)
    await window.aliax.proxySetEnabled(false)
    const result = await window.aliax.proxyRemoveShell()
    setBusy(false)
    onChanged()
    toast.success(
      result.ok && result.notes?.length
        ? result.notes.join(' · ')
        : 'Instant switching off. Switches restart your terminal sessions'
    )
  }

  return (
    <div
      className={cn(
        'flex h-12 items-center gap-3 rounded-xl border px-3.5 transition-colors',
        on ? 'border-success/25 bg-success/[0.06]' : 'border-border bg-card/60'
      )}
    >
      <Zap className={cn('size-4 shrink-0', on ? 'text-success' : 'text-muted-foreground')} />

      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">Instant switching</span>
          <span
            className={cn(
              'rounded px-1.5 py-0.5 text-[10px] font-semibold tracking-wide uppercase',
              on ? 'bg-success/15 text-success' : 'bg-white/8 text-muted-foreground'
            )}
          >
            {on ? 'On' : 'Off'}
          </span>
        </div>
        <div className="truncate text-xs text-muted-foreground">
          {on
            ? routed > 0
              ? `Switching accounts takes effect without restarting sessions · ${routed} requests routed`
              : 'Switching accounts takes effect without restarting sessions'
            : 'Switching accounts restarts your terminal sessions'}
        </div>
      </div>

      <div className="ml-auto flex shrink-0 items-center gap-2">
        {on && (
          <Button
            variant="ghost"
            size="xs"
            className="text-muted-foreground hover:text-foreground"
            onClick={onOpen}
          >
            Details
          </Button>
        )}
        {busy ? (
          <Loader variant="spinner" size={16} className="mx-3 text-muted-foreground" />
        ) : on ? (
          // A named button, not a toggle: this is what you reach for when
          // something is going wrong, so it should never need interpreting.
          <Button variant="outline" size="sm" onClick={turnOff}>
            <Power />
            Turn off
          </Button>
        ) : (
          <Button size="sm" onClick={onOpen}>
            <Zap />
            Turn on
          </Button>
        )}
      </div>
    </div>
  )
}
