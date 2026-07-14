"use client"

import { Shimmer } from "@/components/ai-elements/shimmer"
import { cn } from "@/lib/utils"
import { motion, useReducedMotion } from "motion/react"
import Image from "next/image"
import { useEffect, useState, type ReactElement } from "react"

/** The emblem spinning steadily clockwise - a sleek "agent thinking" tell. */
function WorkingEmblem({ reducedMotion }: { reducedMotion: boolean }): ReactElement {
  return (
    <motion.span
      className="inline-flex size-[30px]"
      initial={{ rotate: 0 }}
      animate={reducedMotion ? undefined : { rotate: 360 }}
      transition={{ duration: 2.5, ease: "linear", repeat: Number.POSITIVE_INFINITY }}
    >
      <Image alt="" aria-hidden="true" height={30} src="/emblem.svg" width={30} />
    </motion.span>
  )
}

export type AgentWorkingIndicatorProps = {
  isWorking: boolean
  className?: string
}

/**
 * Shows a shimmer "Working..." text while the agent is busy.
 *
 * Render-time setState avoids cascading renders from useEffect.
 * The 260ms hide delay prevents flicker when the agent finishes.
 */
export function AgentWorkingIndicator({
  isWorking,
  className,
}: AgentWorkingIndicatorProps): ReactElement {
  const reducedMotion = useReducedMotion() ?? false
  const [visible, setVisible] = useState(isWorking)

  if (isWorking && !visible) {
    setVisible(true)
  }

  useEffect(() => {
    if (isWorking) return
    const timer = setTimeout(() => setVisible(false), 260)
    return () => clearTimeout(timer)
  }, [isWorking])

  if (!visible) return <></>

  return (
    <div
      aria-live="polite"
      className={cn("inline-flex items-center gap-2", className)}
      role="status"
      style={{
        opacity: isWorking ? 1 : 0,
        transition: "opacity 220ms ease-out",
      }}
    >
      <WorkingEmblem reducedMotion={reducedMotion} />
      <Shimmer>Working...</Shimmer>
    </div>
  )
}
