"use client"

import { cn } from "@/lib/utils"
import type { ReactElement } from "react"

export type AgentWorkingIndicatorProps = {
  isWorking: boolean
  className?: string
}

/**
 * Shows the AgentZ bot thinking while the agent is busy.
 *
 */
export function AgentWorkingIndicator({
  isWorking,
  className,
}: AgentWorkingIndicatorProps): ReactElement {
  if (!isWorking) return <></>

  return (
    <div
      aria-live="polite"
      className={cn("inline-flex items-center gap-2", className)}
      role="status"
    >
      <span aria-hidden="true" className="inline-flex items-center gap-[3px]">
        <span className="bg-muted-foreground/30 animate-status-pulse size-1 rounded-full" />
        <span className="bg-muted-foreground/30 animate-status-pulse size-1 rounded-full [animation-delay:200ms]" />
        <span className="bg-muted-foreground/30 animate-status-pulse size-1 rounded-full [animation-delay:400ms]" />
      </span>
      <span className="text-muted-foreground text-xs tabular-nums">Working...</span>
    </div>
  )
}
