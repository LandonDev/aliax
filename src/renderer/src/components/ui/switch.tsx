import * as React from "react"
import { Switch as SwitchPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"

function Switch({ className, ...props }: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "peer relative inline-flex h-[18px] w-8 shrink-0 items-center rounded-full border border-transparent transition-colors outline-none",
        "after:absolute after:-inset-x-2 after:-inset-y-2",
        "focus-visible:ring-2 focus-visible:ring-ring/50",
        "data-[state=checked]:bg-primary data-[state=unchecked]:bg-secondary",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          "pointer-events-none block size-3.5 rounded-full transition-transform",
          "data-[state=checked]:translate-x-[15px] data-[state=checked]:bg-primary-foreground",
          "data-[state=unchecked]:translate-x-[2px] data-[state=unchecked]:bg-muted-foreground"
        )}
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
