import { useEffect, useState } from 'react'
import type { ServiceView, Settings } from '../../../shared/types'
import { BrandMark, SERVICE_TINT } from '@/components/brand'
import { IconTile } from '@/components/reui/icon-tile'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'

export function SettingsDialog({
  open,
  onOpenChange,
  views
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  views: ServiceView[]
}) {
  const [settings, setSettings] = useState<Settings | null>(null)

  useEffect(() => {
    if (open) window.aliax.getSettings().then(setSettings)
  }, [open])

  const toggle = (serviceId: ServiceView['id'], targetId: string, enabled: boolean) => {
    if (!settings) return
    const next: Settings = {
      ...settings,
      switchTargets: {
        ...settings.switchTargets,
        [serviceId]: { ...settings.switchTargets[serviceId], [targetId]: enabled }
      }
    }
    setSettings(next)
    window.aliax.setSettings(next)
  }

  const services = views.filter((s) => s.installed && s.switchTargets.length > 0)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>How Aliax starts, and what a switch signs in.</DialogDescription>
        </DialogHeader>

        {settings && (
          <div className="space-y-6">
            <div className="flex items-center justify-between gap-4">
              <Label htmlFor="launch-at-login" className="text-sm font-normal">
                Open at login
                <span className="block text-xs text-muted-foreground">
                  Starts in the menu bar
                </span>
              </Label>
              <Switch
                id="launch-at-login"
                checked={settings.launchAtLogin === true}
                onCheckedChange={(v) => {
                  const next: Settings = { ...settings, launchAtLogin: v }
                  setSettings(next)
                  window.aliax.setSettings(next)
                }}
              />
            </div>

            {services.map((s) => (
              <section key={s.id}>
                <div className="flex items-center gap-2.5 pb-3">
                  <IconTile variant="frame" size="sm" style={{ color: SERVICE_TINT[s.id] }}>
                    <BrandMark id={s.id} />
                  </IconTile>
                  <h3 className="text-sm font-semibold tracking-tight">{s.name}</h3>
                </div>
                <div className="space-y-3 pl-[2.625rem]">
                  {s.switchTargets.map((t) => {
                    const id = `${s.id}-${t.id}`
                    const enabled = settings.switchTargets[s.id]?.[t.id] !== false
                    return (
                      <div key={t.id} className="flex items-center justify-between gap-4">
                        <Label htmlFor={id} className="text-sm font-normal text-muted-foreground">
                          {t.label}
                        </Label>
                        <Switch
                          id={id}
                          checked={enabled}
                          onCheckedChange={(v) => toggle(s.id, t.id, v === true)}
                        />
                      </div>
                    )
                  })}
                </div>
              </section>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
