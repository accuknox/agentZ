"use client"

import * as React from "react"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { dayjs } from "@/lib/format"
import { cn } from "@/lib/utils"

export type RelativeDateTimeProps = {
  value: string | number | Date
  exact?: boolean
  className?: string
}

export function RelativeDateTime({ value, exact = false, className }: RelativeDateTimeProps) {
  const [, refresh] = React.useReducer((count: number) => count + 1, 0)

  React.useEffect(() => {
    if (exact) return
    const interval = window.setInterval(refresh, 60_000)
    return () => window.clearInterval(interval)
  }, [exact])

  const date = dayjs(value)
  const exactLabel = date.tz(dayjs.tz.guess()).format("LLLL z")
  const timestamp = (
    <time
      className={cn("text-muted-foreground tabular-nums", className)}
      dateTime={date.toISOString()}
      suppressHydrationWarning
      tabIndex={exact ? undefined : 0}
    >
      {exact ? exactLabel : date.fromNow()}
    </time>
  )

  if (exact) return timestamp

  return (
    <Tooltip>
      <TooltipTrigger asChild>{timestamp}</TooltipTrigger>
      <TooltipContent>{exactLabel}</TooltipContent>
    </Tooltip>
  )
}
