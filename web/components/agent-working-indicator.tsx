"use client"

import { Shimmer } from "@/components/ai-elements/shimmer"
import { useEffect, useRef, useState, type ReactElement } from "react"

export type AgentWorkingIndicatorProps = {
  isWorking: boolean
  className?: string
}

/**
 * Shows a shimmer "Working…" text while the agent is busy.
 *
 * Render-time setState avoids cascading renders from useEffect.
 * The 260ms hide delay prevents flicker when the agent finishes.
 */
export function AgentWorkingIndicator({
  isWorking,
  className,
}: AgentWorkingIndicatorProps): ReactElement {
  const [visible, setVisible] = useState(isWorking)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  if (isWorking && !visible) {
    setVisible(true)
  }

  useEffect(() => {
    if (!isWorking) {
      timeoutRef.current = setTimeout(() => {
        setVisible(false)
      }, 260)
      return () => {
        if (timeoutRef.current) {
          clearTimeout(timeoutRef.current)
          timeoutRef.current = null
        }
      }
    }
  }, [isWorking])

  if (!visible) return <></>

  return (
    <div
      className={className}
      style={{
        opacity: isWorking ? 1 : 0,
        transition: "opacity 220ms ease-out",
      }}
    >
      <Shimmer>Working…</Shimmer>
    </div>
  )
}
