import type { ServiceId, ServiceView, UsageReport } from '../../../shared/types'
import { BrandMark, SERVICE_TINT } from '@/components/brand'
import { Loader } from '@/components/motion/loader'
import { DEFAULT_COLOR, displayName, isLive, percentLeft, toneFor, useNow } from '@/lib/accounts'
import { cn } from '@/lib/utils'

export function MiniView({
  views,
  usage,
  busy,
  onUse
}: {
  views: ServiceView[]
  usage: Partial<Record<ServiceId, UsageReport[]>>
  busy: string | null
  onUse: (serviceId: ServiceId, name: string) => void
}) {
  const now = useNow()
  const withProfiles = views.filter((s) => s.installed && s.profiles.length > 0)

  if (withProfiles.length === 0) {
    return <p className="pt-10 text-center text-xs text-muted-foreground">No saved accounts yet.</p>
  }

  return (
    <div className="panel divide-y divide-border overflow-hidden">
      {withProfiles.map((s) => (
        <section key={s.id}>
          <header className="flex h-8 items-center gap-2 bg-white/[0.02] px-3">
            <BrandMark id={s.id} className="size-3 shrink-0" style={{ color: SERVICE_TINT[s.id] }} />
            <span className="text-[11px] font-medium tracking-tight text-muted-foreground">
              {s.name}
            </span>
          </header>
          <ul className="divide-y divide-border/60">
            {s.profiles.map((p) => {
              const report = usage[s.id]?.find((r) => r.profileName === p.name)
              const first = report?.windows[0]
              const left = first ? percentLeft(first) : null
              const color = p.color ?? DEFAULT_COLOR
              const live = isLive(p)
              const spinning = busy === `use:${s.id}:${p.name}`
              const switchable = !p.active && !spinning
              return (
                <li
                  key={p.name}
                  onClick={() => switchable && onUse(s.id, p.name)}
                  onKeyDown={(e) => {
                    if (switchable && (e.key === 'Enter' || e.key === ' ')) {
                      e.preventDefault()
                      onUse(s.id, p.name)
                    }
                  }}
                  role={p.active ? undefined : 'button'}
                  tabIndex={p.active ? undefined : 0}
                  aria-label={p.active ? undefined : `Switch to ${displayName(p)}`}
                  className={cn(
                    'group flex h-11 items-center gap-2.5 px-3 transition-colors',
                    live ? 'bg-white/[0.03]' : 'hover:bg-white/[0.02]',
                    switchable && 'cursor-pointer'
                  )}
                >
                  {spinning ? (
                    <Loader variant="spinner" size={13} className="shrink-0 text-muted-foreground" />
                  ) : (
                    <span
                      aria-hidden
                      className="grid size-3.5 shrink-0 place-items-center rounded-full"
                      style={{ boxShadow: `inset 0 0 0 1.5px ${live ? color : `${color}66`}` }}
                    >
                      <span
                        className={cn(
                          'size-1.5 rounded-full transition-opacity',
                          live ? 'opacity-100' : 'opacity-0 group-hover:opacity-45'
                        )}
                        style={{ backgroundColor: color }}
                      />
                    </span>
                  )}
                  <span
                    className={cn(
                      'truncate text-[13px] transition-colors',
                      live ? 'font-medium' : 'text-muted-foreground group-hover:text-foreground'
                    )}
                  >
                    {displayName(p)}
                  </span>
                  <span className="ml-auto flex shrink-0 items-baseline gap-1.5">
                    {(report?.banked ?? 0) > 0 && (
                      <span className="text-[11px] font-medium text-success">
                        +{report?.banked}
                      </span>
                    )}
                    <span
                      className={cn(
                        'text-[13px] font-medium',
                        left === null || !first ? 'text-muted-foreground/50' : toneFor(first, now)
                      )}
                    >
                      {left === null ? '–' : `${Math.round(left)}%`}
                    </span>
                  </span>
                </li>
              )
            })}
          </ul>
        </section>
      ))}
    </div>
  )
}
