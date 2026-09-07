"use client"

import * as React from "react"
import { formatDurationSeconds } from "@/lib/format"
import type { WorkflowRunDetail } from "@/lib/gateway/client"

type RunElapsedProps = Pick<
  WorkflowRunDetail,
  "status" | "started_at" | "completed_at" | "duration_seconds"
>

/** RunElapsed keeps the live clock local to each timing display. */
export function RunElapsed({
  status,
  started_at,
  completed_at,
  duration_seconds,
}: RunElapsedProps) {
  const [now, setNow] = React.useState(0)
  const running = status === "Running" && started_at !== undefined && completed_at === undefined

  React.useEffect(() => {
    if (!running) return

    const refresh = () => setNow(Date.now())
    // Sample after hydration, then use wall time so background tabs do not drift.
    const frame = window.requestAnimationFrame(refresh)
    const interval = window.setInterval(refresh, 1000)
    document.addEventListener("visibilitychange", refresh)

    return () => {
      window.cancelAnimationFrame(frame)
      window.clearInterval(interval)
      document.removeEventListener("visibilitychange", refresh)
    }
  }, [running, started_at])

  let seconds = duration_seconds
  if (seconds === undefined && started_at !== undefined) {
    if (completed_at !== undefined) {
      seconds = Math.ceil((Date.parse(completed_at) - Date.parse(started_at)) / 1000)
    } else if (running && now > 0) {
      seconds = Math.ceil((now - Date.parse(started_at)) / 1000)
    }
  }

  if (seconds !== undefined) {
    return <span className="tabular-nums">{formatDurationSeconds(Math.max(0, seconds))}</span>
  }

  return (
    <span className="text-muted-foreground">
      {status === "Pending" && started_at === undefined
        ? "Not started"
        : running
          ? "..."
          : "Unavailable"}
    </span>
  )
}
